import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { ChatMessage } from "@shoggoth/models";
import {
  createFailoverToolCallingClientFromModelsConfig,
  mergeModelInvocationParams,
  type CreateFailoverFromConfigOptions,
  type FailoverToolCallingClient,
} from "@shoggoth/models";
import { toolExec, toolExecExtended, toolPoll, toolRead, toolWrite, type AgentCredentials } from "@shoggoth/os-exec";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  isSubagentSessionUrn,
  resolveAgentIdFromSessionId,
  resolveEffectiveMemoryForSession,
  resolveEffectiveModelsConfig,
  resolveEffectiveSessionQueryAllowedAgentIds,
} from "@shoggoth/shared";
import { mergeOrchestratorEnv } from "../config/effective-runtime";
import { getAgentIntegrationInvoker } from "../control/agent-integration-invoke-ref";
import { IntegrationOpError } from "../control/integration-ops";
import { readFileSync } from "node:fs";
import { listSkillsForConfig, skillAbsolutePathById } from "@shoggoth/skills-plugins";
import { runMemoryBuiltin } from "../memory/builtin-memory-tools";
import { getProcessManager } from "../process-manager-singleton";
import { createMcpRoutingToolExecutor } from "../mcp/tool-loop-mcp";
import { createToolLoopPolicyAndAudit } from "../policy/tool-loop-bridge";
import { runToolLoop, type RunToolLoopHitl, type RunToolLoopOptions } from "./tool-loop";
import type { TranscriptStore } from "./transcript-store";
import type { ToolRunStore } from "./tool-run-store";
import type { SessionRow } from "./session-store";
import {
  extractLatestTranscriptAssistantText,
  loadSessionTranscriptAsModelChat,
} from "./transcript-to-chat";
import {
  createSessionToolLoopModelClient,
  type SessionToolLoopFailoverState,
  type SessionToolLoopModelClient,
} from "./session-tool-loop-model-client";
import type { SessionMcpToolContext } from "./session-mcp-tool-context";
import type { PolicyEngine } from "../policy/engine";
import {
  beginSessionTurnAbortScope,
  TurnAbortedError,
} from "./session-turn-abort";
import { messageToolContextRef } from "../messaging/message-tool-context-ref";
import { recordAgentTurn } from "./session-stats-store";
import { checkContextWindowMismatch } from "./context-window-mismatch";
import { getModelContextWindowTokens } from "../model-metadata";

export interface ExecuteSessionAgentTurnInput {
  readonly db: Database.Database;
  readonly sessionId: string;
  readonly session: SessionRow;
  readonly transcript: TranscriptStore;
  readonly toolRuns: ToolRunStore;
  readonly userContent: string;
  readonly userMetadata: Record<string, unknown> | undefined;
  readonly systemPrompt: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: ShoggothConfig;
  readonly policyEngine: PolicyEngine;
  readonly getHitlConfig: () => ShoggothConfig["hitl"];
  readonly hitl: Omit<RunToolLoopHitl, "config">;
  readonly loopImpl?: (opts: RunToolLoopOptions) => Promise<void>;
  readonly createToolCallingClient?: (
    models: ShoggothConfig["models"],
    options?: CreateFailoverFromConfigOptions,
  ) => FailoverToolCallingClient;
  readonly resolveMcpContext: (sessionId: string) => Promise<SessionMcpToolContext>;
  readonly stream?: {
    readonly streamModel: boolean;
    readonly onModelTextDelta?: (displayText: string) => void | Promise<void>;
  };
}

export interface SessionAgentTurnResult {
  readonly failoverMeta: SessionToolLoopFailoverState | undefined;
  readonly latestAssistantText: string;
}

function sessionCreds(uid?: number, gid?: number): AgentCredentials {
  const u = uid ?? process.getuid?.() ?? 0;
  const g = gid ?? process.getgid?.() ?? 0;
  return { uid: u, gid: g };
}

/**
 * Appends the user turn, runs the tool loop with MCP + built-ins, and returns the latest
 * assistant text plus failover metadata. Caller handles message-platform delivery and formatting.
 * CI/non-Discord entrypoint: `test/sessions/session-agent-turn.test.ts` (mocked model client).
 */
export async function executeSessionAgentTurn(
  input: ExecuteSessionAgentTurnInput,
): Promise<SessionAgentTurnResult> {
  const loopImpl = input.loopImpl ?? runToolLoop;
  const ctxSeg = input.session.contextSegmentId.trim();
  if (!ctxSeg) {
    throw new Error("executeSessionAgentTurn: session.contextSegmentId must be non-empty");
  }

  input.transcript.append({
    sessionId: input.sessionId,
    contextSegmentId: ctxSeg,
    role: "user",
    content: input.userContent,
    metadata: input.userMetadata ?? {},
  });

  const history = loadSessionTranscriptAsModelChat(input.db, input.sessionId, ctxSeg);
  const system: ChatMessage = {
    role: "system",
    content: input.systemPrompt,
  };
  const initialMessages: ChatMessage[] = [system, ...history];

  const mcpCtx = await input.resolveMcpContext(input.sessionId);

  const createToolClient =
    input.createToolCallingClient ?? createFailoverToolCallingClientFromModelsConfig;
  const modelsForSession =
    resolveEffectiveModelsConfig(input.config, input.sessionId) ?? input.config.models;
  const toolClient = createToolClient(modelsForSession, { env: input.env });

  const modelInvocation = mergeModelInvocationParams(modelsForSession, input.session.modelSelection);

  const model: SessionToolLoopModelClient = createSessionToolLoopModelClient({
    toolClient,
    initialMessages,
    tools: mcpCtx.toolsOpenAi,
    modelInvocation,
    streamModel: Boolean(input.stream?.streamModel),
    onModelTextDelta: input.stream?.onModelTextDelta,
  });

  const principal: AuthenticatedPrincipal = {
    kind: "agent",
    sessionId: input.sessionId,
    source: "agent",
  };

  const runId = randomUUID();
  const { policy, audit } = createToolLoopPolicyAndAudit({
    engine: input.policyEngine,
    principal,
    db: input.db,
    correlationId: runId,
  });

  const creds = sessionCreds(input.session.runtimeUid, input.session.runtimeGid);
  const orchestratorEnv = mergeOrchestratorEnv(input.config, input.env);

  const executor = createMcpRoutingToolExecutor({
    aggregated: mcpCtx.aggregated,
    ...(mcpCtx.external ? { external: mcpCtx.external } : {}),
    builtin: async ({ originalName, argsJson }) => {
      try {
        const args = JSON.parse(argsJson) as Record<string, unknown>;
        if (originalName === "message") {
          const ctx = messageToolContextRef.current;
          if (!ctx) {
            return { resultJson: JSON.stringify({ error: "message_tool_unavailable" }) };
          }
          const result = await ctx.execute(input.sessionId, args);
          return { resultJson: JSON.stringify(result) };
        }
        if (originalName === "session.query") {
          const callerAgentId = resolveAgentIdFromSessionId(input.sessionId);
          if (!callerAgentId) {
            return { resultJson: JSON.stringify({ error: "session.query requires a valid agent session URN" }) };
          }
          const requestedAgentId = typeof args.agent_id === "string" && args.agent_id.trim()
            ? args.agent_id.trim()
            : callerAgentId;
          const allowed = resolveEffectiveSessionQueryAllowedAgentIds(input.config, callerAgentId);
          if (!allowed.has(requestedAgentId)) {
            return { resultJson: JSON.stringify({ error: `not allowed to query sessions for agent id: ${requestedAgentId}` }) };
          }
          const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit) || 50)), 200);
          const offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
          const sessionIdFilter = typeof args.session_id === "string" && args.session_id.trim()
            ? args.session_id.trim()
            : undefined;
          // Verify requested session belongs to the allowed agent id
          if (sessionIdFilter) {
            const sessionAgent = resolveAgentIdFromSessionId(sessionIdFilter);
            if (sessionAgent !== requestedAgentId) {
              return { resultJson: JSON.stringify({ error: `session ${sessionIdFilter} does not belong to agent ${requestedAgentId}` }) };
            }
          }

          // --- Role filter ---
          const roleRaw = args.role;
          let roleFilter: string[] | undefined;
          if (typeof roleRaw === "string" && roleRaw.trim()) {
            roleFilter = [roleRaw.trim()];
          } else if (Array.isArray(roleRaw) && roleRaw.length > 0 && roleRaw.every((r: unknown) => typeof r === "string")) {
            roleFilter = roleRaw as string[];
          }
          // Empty array means no filter (all roles)

          // --- Search parameters (mutually exclusive) ---
          const queryStr = typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined;
          const queryRegexStr = typeof args.queryRegex === "string" && args.queryRegex.trim() ? args.queryRegex.trim() : undefined;
          if (queryStr && queryRegexStr) {
            return { resultJson: JSON.stringify({ error: "query and queryRegex are mutually exclusive; provide only one" }) };
          }
          // Validate regex early to avoid runtime crashes
          let compiledRegex: RegExp | undefined;
          if (queryRegexStr) {
            try {
              compiledRegex = new RegExp(queryRegexStr, "i");
            } catch (e) {
              return { resultJson: JSON.stringify({ error: `invalid queryRegex pattern: ${String(e)}` }) };
            }
          }

          // --- Metadata parameters ---
          const metadataOnly = args.metadataOnly === true;
          const includeMetadata = metadataOnly || args.includeMetadata === true;

          // Build SQL query with optional role filter and substring search.
          // Regex and limit/offset on filtered results are applied in JS for correctness
          // (offset/limit apply to the *filtered* result set, not the raw SQL rows).
          const whereClauses: string[] = [];
          const params: Record<string, unknown> = {};

          if (sessionIdFilter) {
            whereClauses.push("session_id = @session_id");
            params.session_id = sessionIdFilter;
          } else {
            whereClauses.push("session_id IN (SELECT id FROM sessions WHERE id LIKE @agent_pattern)");
            params.agent_pattern = `agent:${requestedAgentId}:%`;
          }

          // Role filter in SQL for efficiency
          if (roleFilter && roleFilter.length > 0) {
            const rolePlaceholders = roleFilter.map((_, i) => `@role_${i}`);
            whereClauses.push(`role IN (${rolePlaceholders.join(", ")})`);
            roleFilter.forEach((r, i) => { params[`role_${i}`] = r; });
          }

          // Substring search in SQL (SQLite LIKE is case-insensitive for ASCII)
          if (queryStr) {
            whereClauses.push("content LIKE @query_like");
            params.query_like = `%${queryStr}%`;
          }

          // When regex or query filtering is active, we fetch a larger batch from SQL
          // and apply JS-side filtering + pagination. When no JS-side filter is needed,
          // we can use SQL offset/limit directly.
          const needsJsFilter = Boolean(compiledRegex);

          let sql: string;
          if (needsJsFilter) {
            // Fetch more rows than needed; JS will filter and paginate
            sql = `SELECT seq, role, content, tool_call_id, tool_calls_json, metadata_json, session_id, created_at
                   FROM transcript_messages
                   WHERE ${whereClauses.join(" AND ")}
                   ORDER BY ${sessionIdFilter ? "seq" : "session_id, seq"} ASC`;
          } else {
            whereClauses.push("seq > @offset");
            params.offset = offset;
            params.limit = limit;
            sql = `SELECT seq, role, content, tool_call_id, tool_calls_json, metadata_json, session_id, created_at
                   FROM transcript_messages
                   WHERE ${whereClauses.join(" AND ")}
                   ORDER BY ${sessionIdFilter ? "seq" : "session_id, seq"} ASC
                   LIMIT @limit`;
          }

          const stmt = input.db.prepare(sql);
          type RawRow = {
            seq: number; role: string; content: string | null;
            tool_call_id: string | null; tool_calls_json: string | null;
            metadata_json: string | null; session_id: string; created_at: string | null;
          };
          let rows = stmt.all(params) as RawRow[];

          // JS-side regex filter + pagination when needed
          if (compiledRegex) {
            rows = rows.filter((r) => r.content != null && compiledRegex!.test(r.content));
            // Apply offset/limit to the filtered set
            const startIdx = rows.findIndex((r) => r.seq > offset);
            if (startIdx === -1) {
              rows = [];
            } else {
              rows = rows.slice(startIdx, startIdx + limit);
            }
          }

          /** Approximate token count: ~4 chars per token (cl100k_base heuristic). */
          const estimateTokens = (text: string | null): number =>
            text ? Math.max(1, Math.ceil(text.length / 4)) : 0;

          // Track absolute index across the full transcript for metadata
          let indexMap: Map<string, number> | undefined;
          if (includeMetadata) {
            // Build a seq-to-index map for the rows we're returning.
            // Index is the absolute 0-based position within the session's transcript.
            // We compute it by counting rows with seq <= current seq per session.
            indexMap = new Map();
            const sessionIds = [...new Set(rows.map((r) => r.session_id))];
            for (const sid of sessionIds) {
              const countStmt = input.db.prepare(
                `SELECT seq, ROW_NUMBER() OVER (ORDER BY seq ASC) - 1 AS idx
                 FROM transcript_messages WHERE session_id = @sid ORDER BY seq ASC`,
              );
              const indexRows = countStmt.all({ sid }) as { seq: number; idx: number }[];
              for (const ir of indexRows) {
                indexMap.set(`${sid}:${ir.seq}`, ir.idx);
              }
            }
          }

          const messages = rows.map((r) => {
            const base: Record<string, unknown> = {
              session_id: r.session_id,
              seq: r.seq,
              role: r.role,
            };
            // Include content unless metadataOnly
            if (!metadataOnly) {
              base.content = r.content;
              if (r.tool_call_id) base.tool_call_id = r.tool_call_id;
              if (r.tool_calls_json) base.tool_calls = JSON.parse(r.tool_calls_json);
            }
            // Include _meta when requested
            if (includeMetadata) {
              base._meta = {
                timestamp: r.created_at ?? null,
                tokenCount: estimateTokens(r.content),
                index: indexMap?.get(`${r.session_id}:${r.seq}`) ?? null,
              };
            }
            return base;
          });
          return { resultJson: JSON.stringify({ messages, count: messages.length }) };
        }
        if (originalName === "subagent" || originalName.startsWith("session.")) {
          const inv = getAgentIntegrationInvoker();
          if (!inv) {
            return { resultJson: JSON.stringify({ error: "subagent_control_unavailable" }) };
          }
          if (originalName === "subagent" && isSubagentSessionUrn(input.sessionId)) {
            return { resultJson: JSON.stringify({ error: "subagent_tool_top_level_only" }) };
          }
          let op: string;
          let payload: Record<string, unknown>;
          if (originalName === "subagent") {
            const action = String(args.action ?? "").trim();
            if (!action) {
              return { resultJson: JSON.stringify({ error: "action required" }) };
            }
            if (action === "spawn_one_shot") {
              const prompt = String(args.prompt ?? "").trim();
              if (!prompt) {
                return { resultJson: JSON.stringify({ error: "prompt required" }) };
              }
              op = "subagent_spawn";
              payload = {
                parent_session_id: input.sessionId,
                prompt,
                mode: "one_shot",
              };
              const respondTo = args.respond_to;
              if (typeof respondTo === "string" && respondTo.trim()) {
                payload.respond_to = respondTo.trim();
              }
              if (args.internal === false) payload.internal = false;
            } else if (action === "spawn_bound") {
              const prompt = String(args.prompt ?? "").trim();
              const threadId = String(args.thread_id ?? "").trim();
              if (!prompt || !threadId) {
                return { resultJson: JSON.stringify({ error: "thread_id and prompt required" }) };
              }
              op = "subagent_spawn";
              payload = {
                parent_session_id: input.sessionId,
                prompt,
                mode: "bound_thread",
                platform_thread_id: threadId,
              };
              const du = args.platform_user_id;
              if (typeof du === "string" && du.trim()) payload.platform_user_id = du.trim();
              const rt = args.reply_to_message_id;
              if (typeof rt === "string" && rt.trim()) payload.reply_to_message_id = rt.trim();
              const lt = args.lifetime_ms;
              if (typeof lt === "number" && Number.isFinite(lt) && lt > 0) {
                payload.lifetime_ms = Math.trunc(lt);
              }
              const respondTo = args.respond_to;
              if (typeof respondTo === "string" && respondTo.trim()) {
                payload.respond_to = respondTo.trim();
              }
              if (args.internal === false) payload.internal = false;
            } else if (action === "inspect") {
              op = "session_inspect";
              payload = { session_id: input.sessionId };
            } else if (action === "steer") {
              const sid = String(args.session_id ?? "").trim();
              const prompt = String(args.prompt ?? "").trim();
              if (!sid || !prompt) {
                return { resultJson: JSON.stringify({ error: "session_id and prompt required" }) };
              }
              op = "session_steer";
              payload = { session_id: sid, prompt };
              const del = args.delivery;
              if (del === "internal") payload.delivery = "internal";
              const du = args.platform_user_id;
              if (typeof du === "string" && du.trim()) payload.platform_user_id = du.trim();
              const rt = args.reply_to_message_id;
              if (typeof rt === "string" && rt.trim()) payload.reply_to_message_id = rt.trim();
            } else if (action === "abort") {
              const sid = String(args.session_id ?? "").trim();
              if (!sid) {
                return { resultJson: JSON.stringify({ error: "session_id required" }) };
              }
              op = "session_abort";
              payload = { session_id: sid };
            } else if (action === "kill") {
              const sid = String(args.session_id ?? "").trim();
              if (!sid) {
                return { resultJson: JSON.stringify({ error: "session_id required" }) };
              }
              op = "session_kill";
              payload = { session_id: sid };
            } else if (action === "wait") {
              const sessionIds = args.session_ids;
              if (
                !Array.isArray(sessionIds) ||
                sessionIds.length === 0 ||
                !sessionIds.every((x: unknown) => typeof x === "string")
              ) {
                return {
                  resultJson: JSON.stringify({ error: "session_ids must be a non-empty array of strings" }),
                };
              }
              op = "subagent_wait";
              payload = { session_ids: sessionIds };
              const tm = args.timeout_ms;
              if (typeof tm === "number" && Number.isFinite(tm) && tm > 0) {
                payload.timeout_ms = Math.trunc(tm);
              }
              const md = args.mode;
              if (md === "any" || md === "all") payload.mode = md;
              if (args.include_results === true) payload.include_results = true;
              const mc = args.max_chars;
              if (typeof mc === "number" && Number.isFinite(mc) && mc > 0) {
                payload.max_chars = Math.trunc(mc);
              }
            } else if (action === "result") {
              const sid = String(args.session_id ?? "").trim();
              if (!sid) {
                return { resultJson: JSON.stringify({ error: "session_id required" }) };
              }
              op = "subagent_result";
              payload = { session_id: sid };
              const mc = args.max_chars;
              if (typeof mc === "number" && Number.isFinite(mc) && mc > 0) {
                payload.max_chars = Math.trunc(mc);
              }
            } else {
              return {
                resultJson: JSON.stringify({ error: `unknown subagent action: ${action}` }),
              };
            }
          } else if (originalName === "session.list") {
            op = "session_list";
            payload = {};
            const st = args.status;
            if (typeof st === "string" && st.trim()) payload.status = st.trim();
            const aid = args.agent_id;
            if (typeof aid === "string" && aid.trim()) payload.agent = aid.trim();
          } else if (originalName === "session.send") {
            const message = String(args.message ?? "").trim();
            if (!message) {
              return { resultJson: JSON.stringify({ error: "message required" }) };
            }
            op = "session_send";
            payload = { message };
            if (args.silent === true) payload.silent = true;
            const sid = args.session_id;
            const agid = args.agent_id;
            const hasSid = typeof sid === "string" && sid.trim();
            const hasAg = typeof agid === "string" && agid.trim();
            if (hasSid && hasAg) {
              return {
                resultJson: JSON.stringify({ error: "set only one of session_id or agent_id" }),
              };
            }
            if (hasSid) payload.session_id = (sid as string).trim();
            else if (hasAg) payload.agent_id = (agid as string).trim();
            else {
              return {
                resultJson: JSON.stringify({ error: "session_id or agent_id required" }),
              };
            }
            const du = args.platform_user_id;
            if (typeof du === "string" && du.trim()) payload.platform_user_id = du.trim();
            const rt = args.reply_to_message_id;
            if (typeof rt === "string" && rt.trim()) payload.reply_to_message_id = rt.trim();
          } else {
            return {
              resultJson: JSON.stringify({ error: `unknown integration builtin: ${originalName}` }),
            };
          }
          const mo = args.model_options;
          const spawnAction =
            originalName === "subagent" &&
            (String(args.action ?? "").trim() === "spawn_one_shot" ||
              String(args.action ?? "").trim() === "spawn_bound");
          if (spawnAction && mo && typeof mo === "object" && !Array.isArray(mo)) {
            payload.model_options = mo;
          }
          try {
            const result = await inv(input.sessionId, op, payload);
            return { resultJson: JSON.stringify(result) };
          } catch (e) {
            if (e instanceof IntegrationOpError) {
              return {
                resultJson: JSON.stringify({
                  ok: false,
                  code: e.code,
                  message: e.message,
                }),
              };
            }
            throw e;
          }
        }
        if (originalName === "read") {
          const path = String(args.path ?? "");
          const body = await toolRead(input.session.workspacePath, path, creds);
          return { resultJson: JSON.stringify({ path, content: body }) };
        }
        if (originalName === "write") {
          const path = String(args.path ?? "");
          const content = String(args.content ?? "");
          await toolWrite(input.session.workspacePath, path, content, creds);
          return { resultJson: JSON.stringify({ ok: true, path }) };
        }
        if (originalName === "exec") {
          const argv = args.argv as unknown;
          if (!Array.isArray(argv) || argv.some((x) => typeof x !== "string")) {
            return { resultJson: JSON.stringify({ error: "exec requires string argv[]" }) };
          }
          // Check if any extended params are present
          const hasExtended = args.timeout !== undefined || args.stdin !== undefined ||
            args.workdir !== undefined || args.env !== undefined ||
            args.splitStreams !== undefined || args.maxOutput !== undefined ||
            args.truncation !== undefined || args.background !== undefined ||
            args.yieldMs !== undefined;
          if (hasExtended) {
            // Convert argv to a shell command string for toolExecExtended
            const command = (argv as string[]).map(a =>
              /[^a-zA-Z0-9_\-./=:]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a
            ).join(" ");
            const r = await toolExecExtended(input.session.workspacePath, {
              command,
              timeout: typeof args.timeout === "number" ? args.timeout : undefined,
              stdin: typeof args.stdin === "string" ? args.stdin : undefined,
              workdir: typeof args.workdir === "string" ? args.workdir : undefined,
              env: args.env && typeof args.env === "object" ? args.env as Record<string, string> : undefined,
              splitStreams: typeof args.splitStreams === "boolean" ? args.splitStreams : undefined,
              maxOutput: typeof args.maxOutput === "number" ? args.maxOutput : undefined,
              truncation: typeof args.truncation === "string" ? args.truncation as "head" | "tail" | "both" : undefined,
              background: typeof args.background === "boolean" ? args.background : undefined,
              yieldMs: typeof args.yieldMs === "number" ? args.yieldMs : undefined,
            }, creds);
            if (r.kind === "background") {
              return {
                resultJson: JSON.stringify({
                  status: "running",
                  sessionId: r.sessionId,
                  pid: r.pid,
                  yielded: r.yielded ?? false,
                  partialOutput: r.partialOutput,
                }),
              };
            }
            // Normal foreground completion — check if split streams were used
            if (r.stdout !== undefined || r.stderr !== undefined) {
              return {
                resultJson: JSON.stringify({
                  exitCode: r.exitCode,
                  stdout: r.stdout,
                  stderr: r.stderr,
                  stdoutTruncated: r.stdoutTruncated,
                  stderrTruncated: r.stderrTruncated,
                }),
              };
            }
            return {
              resultJson: JSON.stringify({
                exitCode: r.exitCode,
                output: r.output,
                truncated: r.truncated,
              }),
            };
          }
          const r = await toolExec(input.session.workspacePath, argv as string[], creds);
          return {
            resultJson: JSON.stringify({
              exitCode: r.exitCode,
              stdout: r.stdout,
              stderr: r.stderr,
            }),
          };
        }
        if (originalName === "poll") {
          const pid = typeof args.pid === "number" ? args.pid : undefined;
          if (pid === undefined) {
            return { resultJson: JSON.stringify({ error: "poll requires a numeric pid" }) };
          }
          const r = await toolPoll({
            pid,
            timeout: typeof args.timeout === "number" ? args.timeout : undefined,
            streams: typeof args.streams === "boolean" ? args.streams : undefined,
            tail: typeof args.tail === "number" ? args.tail : undefined,
            since: typeof args.since === "number" ? args.since : undefined,
          });
          return { resultJson: JSON.stringify(r) };
        }
        if (originalName === "memory.search" || originalName === "memory.ingest") {
          return runMemoryBuiltin({
            originalName,
            argsJson,
            db: input.db,
            workspacePath: input.session.workspacePath,
            memory: resolveEffectiveMemoryForSession(input.config, input.sessionId),
            env: orchestratorEnv,
            runtimeOpenaiBaseUrl: input.config.runtime?.openaiBaseUrl,
          });
        }
        if (originalName === "skills") {
          const action = String(args.action ?? "").trim();
          if (action === "list") {
            const rows = listSkillsForConfig(input.config).map((s) => ({
              id: s.id,
              title: s.title,
              path: s.absolutePath,
              enabled: s.enabled,
            }));
            return { resultJson: JSON.stringify(rows) };
          }
          const id = String(args.id ?? "").trim();
          if (!id) {
            return { resultJson: JSON.stringify({ error: "id required for path and read actions" }) };
          }
          if (action === "path") {
            const p = skillAbsolutePathById(input.config, id);
            if (!p) return { resultJson: JSON.stringify({ error: `unknown skill id: ${id}` }) };
            return { resultJson: JSON.stringify({ path: p }) };
          }
          if (action === "read") {
            const p = skillAbsolutePathById(input.config, id);
            if (!p) return { resultJson: JSON.stringify({ error: `unknown skill id: ${id}` }) };
            const content = readFileSync(p, "utf8");
            return { resultJson: JSON.stringify({ path: p, content }) };
          }
          return { resultJson: JSON.stringify({ error: `unknown skills action: ${action}` }) };
        }
        if (originalName === "procman") {
          const action = String(args.action ?? "").trim();
          const pm = getProcessManager();
          if (!pm) {
            return { resultJson: JSON.stringify({ error: "process manager not available" }) };
          }
          if (action === "list") {
            const processes = pm.list().map((mp) => ({
              id: mp.spec.id,
              label: mp.spec.label ?? null,
              state: mp.state,
              pid: mp.pid ?? null,
              uptimeMs: mp.uptimeMs,
              restartCount: mp.restartCount,
              owner: mp.spec.owner,
            }));
            return { resultJson: JSON.stringify({ processes }) };
          }
          if (action === "inspect") {
            const id = String(args.id ?? "").trim();
            if (!id) return { resultJson: JSON.stringify({ error: "id required for inspect" }) };
            const mp = pm.get(id);
            if (!mp) return { resultJson: JSON.stringify({ error: `no process with id "${id}"` }) };
            const recentStdout = mp.readOutput("stdout");
            const recentStderr = mp.readOutput("stderr");
            return {
              resultJson: JSON.stringify({
                id: mp.spec.id,
                label: mp.spec.label ?? null,
                state: mp.state,
                pid: mp.pid ?? null,
                uptimeMs: mp.uptimeMs,
                restartCount: mp.restartCount,
                lastExitCode: mp.lastExitCode,
                lastSignal: mp.lastSignal,
                owner: mp.spec.owner,
                recentStdout,
                recentStderr,
              }),
            };
          }
          return { resultJson: JSON.stringify({ error: `unknown procman action: ${action}` }) };
        }
        return { resultJson: JSON.stringify({ error: `unknown builtin: ${originalName}` }) };
      } catch (e) {
        return { resultJson: JSON.stringify({ error: String(e) }) };
      }
    },
  });

  const { signal: turnAbortSignal, end: endTurnAbortScope } = beginSessionTurnAbortScope(
    input.sessionId,
  );
  try {
    await loopImpl({
      db: input.db,
      sessionId: input.sessionId,
      runId,
      principalId: input.sessionId,
      policy,
      audit,
      model,
      tools: mcpCtx.toolsLoop,
      executor,
      toolRuns: input.toolRuns,
      transcript: input.transcript,
      contextSegmentId: ctxSeg,
      turnAbortSignal,
      hitl: {
        ...input.hitl,
        config: input.getHitlConfig(),
      },
    });
  } catch (e) {
    if (e instanceof TurnAbortedError) {
      const failoverMeta = model.getSessionToolLoopFailoverState();
      const latestAssistantText =
        extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "_Aborted._";
      return { failoverMeta, latestAssistantText };
    }
    throw e;
  } finally {
    endTurnAbortScope();
  }

  const failoverMeta = model.getSessionToolLoopFailoverState();
  const latestAssistantText =
    extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "_No reply text._";

  // --- Session stats: record completed agent turn ---
  const accumulatedUsage = model.getAccumulatedUsage();

  // Fall back to metadata store for context window if provider didn't report it
  let contextWindowTokens = accumulatedUsage?.contextWindowTokens;
  if (contextWindowTokens == null && failoverMeta) {
    contextWindowTokens = getModelContextWindowTokens(failoverMeta.usedProviderId, failoverMeta.usedModel ?? "");
  }

  const transcriptMessageCount = (
    input.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM transcript_messages
         WHERE session_id = @sessionId AND context_segment_id = @ctxSeg`,
      )
      .get({ sessionId: input.sessionId, ctxSeg }) as { cnt: number }
  ).cnt;

  recordAgentTurn(input.db, input.sessionId, {
    inputTokens: accumulatedUsage?.inputTokens ?? 0,
    outputTokens: accumulatedUsage?.outputTokens ?? 0,
    contextWindowTokens,
    transcriptMessageCount,
  });

  // --- Context window mismatch check ---
  if (failoverMeta) {
    checkContextWindowMismatch({
      providerId: failoverMeta.usedProviderId,
      configContextWindow: undefined, // TODO: extract from model config when available
      providerContextWindow: contextWindowTokens,
      sessionId: input.sessionId,
      logger: {
        warn: (msg, fields) => {
          const record = { level: "warn", msg, ...fields, ts: new Date().toISOString() };
          process.stderr.write(`${JSON.stringify(record)}\n`);
        },
      },
      // TODO: wire surfaceWarning to platform binding
      surfaceWarning: undefined,
      suppressNotice: input.config.runtime?.suppressContextWindowMismatchNotice,
    });
  }

  return { failoverMeta, latestAssistantText };
}
