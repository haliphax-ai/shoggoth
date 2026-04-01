import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertValidAgentId, generateSystemContextToken, parseAgentSessionUrn } from "@shoggoth/shared";

export type SessionStatus = "starting" | "active" | "terminated" | string;

/** Subagent spawn mode (see control op `subagent_spawn`). */
export type SubagentMode = "one_shot" | "persistent";

export interface SessionRow {
  readonly id: string;
  readonly agentProfileId: string | undefined;
  readonly workspacePath: string;
  readonly status: SessionStatus;
  /** UUID: scopes `transcript_messages` for model context (internal `new` / `reset` segment lifecycle). */
  readonly contextSegmentId: string;
  readonly modelSelection: unknown;
  readonly lightContext: boolean;
  readonly promptStack: readonly string[];
  readonly runtimeUid: number | undefined;
  readonly runtimeGid: number | undefined;
  readonly parentSessionId: string | undefined;
  readonly subagentMode: SubagentMode | undefined;
  readonly subagentPlatformThreadId: string | undefined;
  readonly subagentExpiresAtMs: number | undefined;
  /** ISO 8601 datetime string from the DB `created_at` column. */
  readonly createdAt: string;
  /** ISO 8601 datetime string from the DB `updated_at` column (tracks last activity). */
  readonly updatedAt: string;
  /** Session-unique anti-spoofing token for trusted system context dividers. */
  readonly systemContextToken: string | undefined;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly workspacePath: string;
  readonly status?: SessionStatus;
  readonly agentProfileId?: string;
  readonly modelSelection?: unknown;
  readonly lightContext?: boolean;
  readonly promptStack?: readonly string[];
  readonly runtimeUid?: number;
  readonly runtimeGid?: number;
}

export interface UpdateSessionInput {
  readonly status?: SessionStatus;
  readonly agentProfileId?: string;
  readonly modelSelection?: unknown;
  readonly lightContext?: boolean;
  readonly promptStack?: readonly string[];
  readonly runtimeUid?: number;
  readonly runtimeGid?: number;
  readonly contextSegmentId?: string;
  readonly parentSessionId?: string | null;
  readonly subagentMode?: SubagentMode | null;
  readonly subagentPlatformThreadId?: string | null;
  readonly subagentExpiresAtMs?: number | null;
  readonly systemContextToken?: string;
}

function rowToSession(r: {
  id: string;
  agent_profile_id: string | null;
  workspace_path: string;
  status: string;
  context_segment_id: string | null;
  model_selection_json: string | null;
  light_context: number;
  prompt_stack_json: string;
  runtime_uid: number | null;
  runtime_gid: number | null;
  parent_session_id?: string | null;
  subagent_mode?: string | null;
  subagent_platform_thread_id?: string | null;
  subagent_expires_at_ms?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  system_context_token?: string | null;
}): SessionRow {
  let model: unknown = undefined;
  if (r.model_selection_json) {
    try {
      model = JSON.parse(r.model_selection_json) as unknown;
    } catch {
      model = undefined;
    }
  }
  let stack: string[] = [];
  try {
    const parsed = JSON.parse(r.prompt_stack_json) as unknown;
    if (Array.isArray(parsed)) stack = parsed.map(String);
  } catch {
    stack = [];
  }
  const contextSegmentId = r.context_segment_id?.trim() ?? "";
  if (!contextSegmentId) {
    throw new Error(`session row ${JSON.stringify(r.id)} is missing context_segment_id`);
  }
  const modeRaw = r.subagent_mode?.trim();
  const subagentMode: SubagentMode | undefined =
    modeRaw === "one_shot" || modeRaw === "persistent" ? (modeRaw as SubagentMode) : undefined;
  const exp = r.subagent_expires_at_ms;
  return {
    id: r.id,
    agentProfileId: r.agent_profile_id ?? undefined,
    workspacePath: r.workspace_path,
    status: r.status,
    contextSegmentId,
    modelSelection: model,
    lightContext: Boolean(r.light_context),
    promptStack: stack,
    runtimeUid: r.runtime_uid ?? undefined,
    runtimeGid: r.runtime_gid ?? undefined,
    parentSessionId: r.parent_session_id?.trim() || undefined,
    subagentMode,
    subagentPlatformThreadId: r.subagent_platform_thread_id?.trim() || undefined,
    subagentExpiresAtMs:
      typeof exp === "number" && Number.isFinite(exp) ? Math.trunc(exp) : undefined,
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
    systemContextToken: r.system_context_token?.trim() || undefined,
  };
}

/** Sort field for `list()`. Maps to DB columns: created → created_at, lastActivity → updated_at, name → id. */
export type SessionSortBy = "created" | "lastActivity" | "name";

export interface SessionListFilter {
  readonly status?: SessionStatus;
  readonly parentSessionId?: string;
  readonly agentId?: string;
  /** Sort field (default: "created"). */
  readonly sortBy?: SessionSortBy;
  /** Sort direction (default: "desc"). */
  readonly sortOrder?: "asc" | "desc";
  /** Inclusive lower bound on last activity (ISO 8601 datetime). Excludes sessions with updated_at before this. */
  readonly activeSince?: string;
  /** Maximum number of sessions to return (applied after sort). */
  readonly limit?: number;
}

export interface SessionStore {
  create(input: CreateSessionInput): void;
  getById(id: string): SessionRow | undefined;
  update(id: string, patch: UpdateSessionInput): void;
  delete(id: string): void;
  list(filter?: SessionListFilter): SessionRow[];
}

/** Current `context_segment_id` for model transcript scoping. */
export function getSessionContextSegmentId(db: Database.Database, sessionId: string): string {
  const r = db
    .prepare(`SELECT context_segment_id FROM sessions WHERE id = @id`)
    .get({ id: sessionId.trim() }) as { context_segment_id: string | null } | undefined;
  const seg = r?.context_segment_id?.trim();
  if (!seg) {
    throw new Error(`session ${JSON.stringify(sessionId)} missing context_segment_id`);
  }
  return seg;
}

export function createSessionStore(db: Database.Database): SessionStore {
  const insert = db.prepare(`
    INSERT INTO sessions (
      id, agent_profile_id, workspace_path, status, context_segment_id,
      model_selection_json, light_context, prompt_stack_json,
      runtime_uid, runtime_gid,
      parent_session_id, subagent_mode, subagent_platform_thread_id, subagent_expires_at_ms,
      system_context_token
    ) VALUES (
      @id, @agent_profile_id, @workspace_path, @status, @context_segment_id,
      @model_selection_json, @light_context, @prompt_stack_json,
      @runtime_uid, @runtime_gid,
      @parent_session_id, @subagent_mode, @subagent_platform_thread_id, @subagent_expires_at_ms,
      @system_context_token
    )
  `);

  const selectOne = db.prepare(`
    SELECT id, agent_profile_id, workspace_path, status, context_segment_id, model_selection_json,
           light_context, prompt_stack_json, runtime_uid, runtime_gid,
           parent_session_id, subagent_mode, subagent_platform_thread_id, subagent_expires_at_ms,
           created_at, updated_at, system_context_token
    FROM sessions WHERE id = @id
  `);

  const del = db.prepare(`DELETE FROM sessions WHERE id = @id`);

  return {
    create(input) {
      const status = input.status ?? "starting";
      insert.run({
        id: input.id,
        agent_profile_id: input.agentProfileId ?? null,
        workspace_path: input.workspacePath,
        status,
        context_segment_id: randomUUID(),
        model_selection_json:
          input.modelSelection !== undefined ? JSON.stringify(input.modelSelection) : null,
        light_context: input.lightContext ? 1 : 0,
        prompt_stack_json: JSON.stringify(input.promptStack ?? []),
        runtime_uid: input.runtimeUid ?? null,
        runtime_gid: input.runtimeGid ?? null,
        parent_session_id: null,
        subagent_mode: null,
        subagent_platform_thread_id: null,
        subagent_expires_at_ms: null,
        system_context_token: generateSystemContextToken(),
      });
    },

    getById(id) {
      const r = selectOne.get({ id }) as
        | {
            id: string;
            agent_profile_id: string | null;
            workspace_path: string;
            status: string;
            context_segment_id: string | null;
            model_selection_json: string | null;
            light_context: number;
            prompt_stack_json: string;
            runtime_uid: number | null;
            runtime_gid: number | null;
            parent_session_id: string | null;
            subagent_mode: string | null;
            subagent_platform_thread_id: string | null;
            subagent_expires_at_ms: number | null;
            system_context_token: string | null;
          }
        | undefined;
      return r ? rowToSession(r) : undefined;
    },

    update(id, patch) {
      const cur = this.getById(id);
      if (!cur) return;
      const nextParent =
        patch.parentSessionId === undefined
          ? cur.parentSessionId ?? null
          : patch.parentSessionId;
      const nextSubMode =
        patch.subagentMode === undefined ? cur.subagentMode ?? null : patch.subagentMode;
      const nextThread =
        patch.subagentPlatformThreadId === undefined
          ? cur.subagentPlatformThreadId ?? null
          : patch.subagentPlatformThreadId;
      const nextExp =
        patch.subagentExpiresAtMs === undefined
          ? cur.subagentExpiresAtMs ?? null
          : patch.subagentExpiresAtMs;
      const nextToken =
        patch.systemContextToken ?? cur.systemContextToken ?? null;
      const next = {
        agent_profile_id: patch.agentProfileId ?? cur.agentProfileId ?? null,
        workspace_path: cur.workspacePath,
        status: patch.status ?? cur.status,
        context_segment_id: patch.contextSegmentId?.trim() ?? cur.contextSegmentId,
        model_selection_json:
          patch.modelSelection !== undefined
            ? JSON.stringify(patch.modelSelection)
            : cur.modelSelection !== undefined
              ? JSON.stringify(cur.modelSelection)
              : null,
        light_context: patch.lightContext !== undefined ? (patch.lightContext ? 1 : 0) : cur.lightContext ? 1 : 0,
        prompt_stack_json:
          patch.promptStack !== undefined ? JSON.stringify(patch.promptStack) : JSON.stringify(cur.promptStack),
        runtime_uid: patch.runtimeUid ?? cur.runtimeUid ?? null,
        runtime_gid: patch.runtimeGid ?? cur.runtimeGid ?? null,
        parent_session_id: nextParent,
        subagent_mode: nextSubMode,
        subagent_platform_thread_id: nextThread,
        subagent_expires_at_ms: nextExp,
        system_context_token: nextToken,
      };
      db.prepare(
        `
        UPDATE sessions SET
          agent_profile_id = @agent_profile_id,
          workspace_path = @workspace_path,
          status = @status,
          context_segment_id = @context_segment_id,
          model_selection_json = @model_selection_json,
          light_context = @light_context,
          prompt_stack_json = @prompt_stack_json,
          runtime_uid = @runtime_uid,
          runtime_gid = @runtime_gid,
          parent_session_id = @parent_session_id,
          subagent_mode = @subagent_mode,
          subagent_platform_thread_id = @subagent_platform_thread_id,
          subagent_expires_at_ms = @subagent_expires_at_ms,
          system_context_token = @system_context_token,
          updated_at = datetime('now')
        WHERE id = @id
      `,
      ).run({ id, ...next });
    },

    delete(id) {
      del.run({ id });
    },

    list(filter) {
      type R = Parameters<typeof rowToSession>[0];
      const cols = `id, agent_profile_id, workspace_path, status, context_segment_id, model_selection_json,
                 light_context, prompt_stack_json, runtime_uid, runtime_gid,
                 parent_session_id, subagent_mode, subagent_platform_thread_id, subagent_expires_at_ms,
                 created_at, updated_at, system_context_token`;

      // --- Map sortBy to DB column ---
      const sortByMap: Record<string, string> = {
        created: "created_at",
        lastActivity: "updated_at",
        name: "id",
      };
      const sortCol = sortByMap[filter?.sortBy ?? "created"] ?? "created_at";
      const sortDir = filter?.sortOrder === "asc" ? "ASC" : "DESC";

      // --- parentSessionId is a special-case filter (used by subagent inspect) ---
      if (filter?.parentSessionId !== undefined) {
        const clauses: string[] = ["parent_session_id = @parent"];
        const params: Record<string, unknown> = { parent: filter.parentSessionId };
        if (filter.activeSince) {
          clauses.push("updated_at >= @activeSince");
          params.activeSince = filter.activeSince;
        }
        let sql = `SELECT ${cols} FROM sessions WHERE ${clauses.join(" AND ")} ORDER BY ${sortCol} ${sortDir}`;
        if (filter.limit !== undefined) {
          sql += " LIMIT @limit";
          params.limit = filter.limit;
        }
        const rows = db.prepare(sql).all(params) as R[];
        return rows.map(rowToSession);
      }

      // --- Build WHERE clauses ---
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter?.status !== undefined) {
        clauses.push("status = @status");
        params.status = filter.status;
      }
      if (filter?.activeSince) {
        clauses.push("updated_at >= @activeSince");
        params.activeSince = filter.activeSince;
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      let sql = `SELECT ${cols} FROM sessions ${where} ORDER BY ${sortCol} ${sortDir}`;

      // When agentId is set, limit must be applied after JS-side URN filtering (below),
      // so only add SQL LIMIT when there is no agentId filter.
      const agentId = filter?.agentId?.trim();
      if (filter?.limit !== undefined && !agentId) {
        sql += " LIMIT @limit";
        params.limit = filter.limit;
      }

      const rows = db.prepare(sql).all(params) as R[];
      let results = rows.map(rowToSession);

      // --- agentId filtering is done in JS (URN parsing, same as before) ---
      if (agentId) {
        assertValidAgentId(agentId);
        results = results.filter((r) => parseAgentSessionUrn(r.id)?.agentId === agentId);
        if (filter?.limit !== undefined) {
          results = results.slice(0, filter.limit);
        }
      }

      return results;
    },
  };
}
