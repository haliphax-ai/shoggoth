// ---------------------------------------------------------------------------
// session-query, subagent, session-list, session-send handlers
// ---------------------------------------------------------------------------

import {
  isSubagentSessionUrn,
  resolveAgentIdFromSessionId,
  resolveEffectiveSessionQueryAllowedAgentIds,
} from "@shoggoth/shared";
import { IntegrationOpError } from "../../control/integration-ops";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { getLogger } from "../../logging";

const log = getLogger("subagent");

export function register(registry: BuiltinToolRegistry): void {
  registry.register("session-query", sessionQuery);
  registry.register("subagent", subagentHandler);
  registry.register("session-list", sessionListHandler);
  registry.register("session-send", sessionSendHandler);
}

// ---------------------------------------------------------------------------
// session-query
// ---------------------------------------------------------------------------

async function sessionQuery(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const callerAgentId = resolveAgentIdFromSessionId(ctx.sessionId);
  if (!callerAgentId) {
    return { resultJson: JSON.stringify({ error: "session-query requires a valid agent session URN" }) };
  }
  const requestedAgentId = typeof args.agent_id === "string" && args.agent_id.trim()
    ? args.agent_id.trim()
    : callerAgentId;
  const allowed = resolveEffectiveSessionQueryAllowedAgentIds(ctx.config, callerAgentId);
  if (!allowed.has(requestedAgentId)) {
    return { resultJson: JSON.stringify({ error: `not allowed to query sessions for agent id: ${requestedAgentId}` }) };
  }
  const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit) || 50)), 200);
  const orderRaw = args.order;
  const order: "asc" | "desc" = orderRaw === "desc" ? "desc" : "asc";
  const hasExplicitOffset = args.offset !== undefined && args.offset !== null;
  const offset = hasExplicitOffset
    ? Math.max(0, Math.trunc(Number(args.offset) || 0))
    : (order === "desc" ? Number.MAX_SAFE_INTEGER : 0);
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

  const needsJsFilter = Boolean(compiledRegex);

  let sql: string;
  if (needsJsFilter) {
    const sqlOrderJs = order === "desc" ? "DESC" : "ASC";
    sql = `SELECT seq, role, content, tool_call_id, tool_calls_json, metadata_json, session_id, created_at
           FROM transcript_messages
           WHERE ${whereClauses.join(" AND ")}
           ORDER BY ${sessionIdFilter ? "seq" : "session_id, seq"} ${sqlOrderJs}`;
  } else {
    whereClauses.push(order === "desc" ? "seq < @offset" : "seq > @offset");
    params.offset = offset;
    params.limit = limit;
    const sqlOrder = order === "desc" ? "DESC" : "ASC";
    sql = `SELECT seq, role, content, tool_call_id, tool_calls_json, metadata_json, session_id, created_at
           FROM transcript_messages
           WHERE ${whereClauses.join(" AND ")}
           ORDER BY ${sessionIdFilter ? "seq" : "session_id, seq"} ${sqlOrder}
           LIMIT @limit`;
  }

  const stmt = ctx.db.prepare(sql);
  type RawRow = {
    seq: number; role: string; content: string | null;
    tool_call_id: string | null; tool_calls_json: string | null;
    metadata_json: string | null; session_id: string; created_at: string | null;
  };
  let rows = stmt.all(params) as RawRow[];

  // JS-side regex filter + pagination when needed
  if (compiledRegex) {
    rows = rows.filter((r) => r.content != null && compiledRegex!.test(r.content));
    const startIdx = order === "desc"
      ? rows.findIndex((r) => r.seq < offset)
      : rows.findIndex((r) => r.seq > offset);
    if (startIdx === -1) {
      rows = [];
    } else {
      rows = rows.slice(startIdx, startIdx + limit);
    }
  }

  /** Approximate token count: ~4 chars per token (cl100k_base heuristic). */
  const estimateTokens = (text: string | null): number =>
    text ? Math.max(1, Math.ceil(text.length / 4)) : 0;

  let indexMap: Map<string, number> | undefined;
  if (includeMetadata) {
    indexMap = new Map();
    const sessionIds = [...new Set(rows.map((r) => r.session_id))];
    for (const sid of sessionIds) {
      const countStmt = ctx.db.prepare(
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
    if (!metadataOnly) {
      base.content = r.content;
      if (r.tool_call_id) base.tool_call_id = r.tool_call_id;
      if (r.tool_calls_json) base.tool_calls = JSON.parse(r.tool_calls_json);
    }
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

// ---------------------------------------------------------------------------
// subagent (spawn_one_shot, spawn_persistent, inspect, steer, abort, kill, wait, result)
// ---------------------------------------------------------------------------

async function subagentHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const inv = ctx.getAgentIntegrationInvoker();
  if (!inv) {
    return { resultJson: JSON.stringify({ error: "subagent_control_unavailable" }) };
  }
  if (ctx.isSubagentSession) {
    return { resultJson: JSON.stringify({ error: "subagent_tool_top_level_only" }) };
  }
  const action = String(args.action ?? "").trim();
  if (!action) {
    return { resultJson: JSON.stringify({ error: "action required" }) };
  }

  let op: string;
  let payload: Record<string, unknown>;

  if (action === "spawn_one_shot") {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) {
      return { resultJson: JSON.stringify({ error: "prompt required" }) };
    }
    op = "subagent_spawn";
    payload = {
      parent_session_id: ctx.sessionId,
      prompt,
      mode: "one_shot",
    };
    const respondTo = args.respond_to;
    if (typeof respondTo === "string" && respondTo.trim()) {
      payload.respond_to = respondTo.trim();
    }
    if (args.internal === false) payload.internal = false;
  } else if (action === "spawn_persistent") {
    const prompt = String(args.prompt ?? "").trim();
    const threadId = String(args.thread_id ?? "").trim();
    if (!prompt) {
      return { resultJson: JSON.stringify({ error: "prompt required" }) };
    }
    op = "subagent_spawn";
    payload = {
      parent_session_id: ctx.sessionId,
      prompt,
      mode: "persistent",
    };
    if (threadId) {
      payload.platform_thread_id = threadId;
    }
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
    payload = { session_id: ctx.sessionId };
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

  // model_options for spawn actions
  const mo = args.model_options;
  const spawnAction = action === "spawn_one_shot" || action === "spawn_persistent";
  if (spawnAction && mo && typeof mo === "object" && !Array.isArray(mo)) {
    payload.model_options = mo;
  }

  log.info("subagent invoked", { action, sessionId: ctx.sessionId });
  if (spawnAction) {
    log.info("subagent spawned", { action, parentSessionId: ctx.sessionId, mode: payload.mode });
  }
  const result = await invokeIntegration(inv, ctx.sessionId, op, payload);
  if (spawnAction) {
    let childId: string | undefined;
    try { const parsed = JSON.parse(result.resultJson); childId = parsed.session_id; } catch { /* ignore */ }
    log.info("subagent completed", { action, childId, parentSessionId: ctx.sessionId });
  }
  return result;
}

// ---------------------------------------------------------------------------
// session-list
// ---------------------------------------------------------------------------

async function sessionListHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const inv = ctx.getAgentIntegrationInvoker();
  if (!inv) {
    return { resultJson: JSON.stringify({ error: "subagent_control_unavailable" }) };
  }
  const payload: Record<string, unknown> = {};
  const st = args.status;
  if (typeof st === "string" && st.trim()) payload.status = st.trim();
  const aid = args.agent_id;
  if (typeof aid === "string" && aid.trim()) payload.agent = aid.trim();
  return invokeIntegration(inv, ctx.sessionId, "session_list", payload);
}

// ---------------------------------------------------------------------------
// session-send
// ---------------------------------------------------------------------------

async function sessionSendHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const inv = ctx.getAgentIntegrationInvoker();
  if (!inv) {
    return { resultJson: JSON.stringify({ error: "subagent_control_unavailable" }) };
  }
  const message = String(args.message ?? "").trim();
  if (!message) {
    return { resultJson: JSON.stringify({ error: "message required" }) };
  }
  const payload: Record<string, unknown> = { message };
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
  return invokeIntegration(inv, ctx.sessionId, "session_send", payload);
}

// ---------------------------------------------------------------------------
// Shared helper: invoke integration op with IntegrationOpError handling
// ---------------------------------------------------------------------------

type InvokerFn = (sessionId: string, op: string, payload: unknown) => Promise<unknown>;

async function invokeIntegration(
  inv: InvokerFn,
  sessionId: string,
  op: string,
  payload: Record<string, unknown>,
): Promise<{ resultJson: string }> {
  try {
    const result = await inv(sessionId, op, payload);
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
