import type Database from "better-sqlite3";

export type SessionStatus = "starting" | "active" | "terminated" | string;

export interface SessionRow {
  readonly id: string;
  readonly agentProfileId: string | undefined;
  readonly workspacePath: string;
  readonly status: SessionStatus;
  readonly modelSelection: unknown;
  readonly lightContext: boolean;
  readonly promptStack: readonly string[];
  readonly runtimeUid: number | undefined;
  readonly runtimeGid: number | undefined;
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
}

function rowToSession(r: {
  id: string;
  agent_profile_id: string | null;
  workspace_path: string;
  status: string;
  model_selection_json: string | null;
  light_context: number;
  prompt_stack_json: string;
  runtime_uid: number | null;
  runtime_gid: number | null;
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
  return {
    id: r.id,
    agentProfileId: r.agent_profile_id ?? undefined,
    workspacePath: r.workspace_path,
    status: r.status,
    modelSelection: model,
    lightContext: Boolean(r.light_context),
    promptStack: stack,
    runtimeUid: r.runtime_uid ?? undefined,
    runtimeGid: r.runtime_gid ?? undefined,
  };
}

export interface SessionStore {
  create(input: CreateSessionInput): void;
  getById(id: string): SessionRow | undefined;
  update(id: string, patch: UpdateSessionInput): void;
  delete(id: string): void;
  list(filter?: { status?: SessionStatus }): SessionRow[];
}

export function createSessionStore(db: Database.Database): SessionStore {
  const insert = db.prepare(`
    INSERT INTO sessions (
      id, agent_profile_id, workspace_path, status,
      model_selection_json, light_context, prompt_stack_json,
      runtime_uid, runtime_gid
    ) VALUES (
      @id, @agent_profile_id, @workspace_path, @status,
      @model_selection_json, @light_context, @prompt_stack_json,
      @runtime_uid, @runtime_gid
    )
  `);

  const selectOne = db.prepare(`
    SELECT id, agent_profile_id, workspace_path, status, model_selection_json,
           light_context, prompt_stack_json, runtime_uid, runtime_gid
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
        model_selection_json:
          input.modelSelection !== undefined ? JSON.stringify(input.modelSelection) : null,
        light_context: input.lightContext ? 1 : 0,
        prompt_stack_json: JSON.stringify(input.promptStack ?? []),
        runtime_uid: input.runtimeUid ?? null,
        runtime_gid: input.runtimeGid ?? null,
      });
    },

    getById(id) {
      const r = selectOne.get({ id }) as
        | {
            id: string;
            agent_profile_id: string | null;
            workspace_path: string;
            status: string;
            model_selection_json: string | null;
            light_context: number;
            prompt_stack_json: string;
            runtime_uid: number | null;
            runtime_gid: number | null;
          }
        | undefined;
      return r ? rowToSession(r) : undefined;
    },

    update(id, patch) {
      const cur = this.getById(id);
      if (!cur) return;
      const next = {
        agent_profile_id: patch.agentProfileId ?? cur.agentProfileId ?? null,
        workspace_path: cur.workspacePath,
        status: patch.status ?? cur.status,
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
      };
      db.prepare(
        `
        UPDATE sessions SET
          agent_profile_id = @agent_profile_id,
          workspace_path = @workspace_path,
          status = @status,
          model_selection_json = @model_selection_json,
          light_context = @light_context,
          prompt_stack_json = @prompt_stack_json,
          runtime_uid = @runtime_uid,
          runtime_gid = @runtime_gid,
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
      if (filter?.status !== undefined) {
        const rows = db
          .prepare(
            `
          SELECT id, agent_profile_id, workspace_path, status, model_selection_json,
                 light_context, prompt_stack_json, runtime_uid, runtime_gid
          FROM sessions WHERE status = @status ORDER BY id
        `,
          )
          .all({ status: filter.status }) as R[];
        return rows.map(rowToSession);
      }
      const rows = db
        .prepare(
          `
        SELECT id, agent_profile_id, workspace_path, status, model_selection_json,
               light_context, prompt_stack_json, runtime_uid, runtime_gid
        FROM sessions ORDER BY id
      `,
        )
        .all() as R[];
      return rows.map(rowToSession);
    },
  };
}
