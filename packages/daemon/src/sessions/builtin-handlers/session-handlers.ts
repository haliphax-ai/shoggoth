// ---------------------------------------------------------------------------
// session-query, subagent, session-list, session-send handlers
// ---------------------------------------------------------------------------

import {
  deriveThreadSubagentAgentId,
  effectiveMaxSpawnDepth,
  maySpawnSubagentAtDepth,
  resolveAgentIdFromSessionId,
  resolveEffectiveSessionQueryAllowedAgentIds,
} from "@shoggoth/shared";
import { randomUUID } from "node:crypto";
import { resolveMaxTtlMs } from "@shoggoth/shared";
import { IntegrationOpError } from "../../control/integration-ops";
import { resolveSessionSendYieldMs } from "../../config/effective-runtime";
import { subagentRuntimeExtensionRef } from "../../subagent/subagent-extension-ref";
import { postTurnSurfaceNotice } from "../../presentation/active-turn-surface";
import {
  getSessionSendNotifyScheduler,
  type SessionSendNotifyHandle,
} from "../session-send-notify-scheduler";
import {
  computeSessionDepthFromStore,
  createSessionStore,
  type SessionStore,
} from "../session-store";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { getSessionSubagentCounts } from "../../presentation/status-bar";
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
    return {
      resultJson: JSON.stringify({
        error: "session-query requires a valid agent session URN",
      }),
    };
  }
  const requestedAgentId =
    typeof args.agent_id === "string" && args.agent_id.trim()
      ? args.agent_id.trim()
      : callerAgentId;
  const allowed = resolveEffectiveSessionQueryAllowedAgentIds(ctx.config, callerAgentId);
  if (!allowed.has(requestedAgentId)) {
    return {
      resultJson: JSON.stringify({
        error: `not allowed to query sessions for agent id: ${requestedAgentId}`,
      }),
    };
  }
  const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit) || 50)), 100);
  const orderRaw = args.order;
  const order: "asc" | "desc" = orderRaw === "asc" ? "asc" : "desc";
  const hasExplicitOffset = args.offset !== undefined && args.offset !== null;
  const offset = hasExplicitOffset
    ? Math.max(0, Math.trunc(Number(args.offset) || 0))
    : order === "desc"
      ? Number.MAX_SAFE_INTEGER
      : 0;
  const sessionIdFilter =
    typeof args.session_id === "string" && args.session_id.trim()
      ? args.session_id.trim()
      : undefined;
  // Verify requested session belongs to the allowed agent id
  if (sessionIdFilter) {
    const sessionAgent = resolveAgentIdFromSessionId(sessionIdFilter);
    if (sessionAgent !== requestedAgentId) {
      return {
        resultJson: JSON.stringify({
          error: `session ${sessionIdFilter} does not belong to agent ${requestedAgentId}`,
        }),
      };
    }
  }

  // --- Role filter ---
  const roleRaw = args.role;
  let roleFilter: string[] | undefined;
  if (typeof roleRaw === "string" && roleRaw.trim()) {
    roleFilter = [roleRaw.trim()];
  } else if (
    Array.isArray(roleRaw) &&
    roleRaw.length > 0 &&
    roleRaw.every((r: unknown) => typeof r === "string")
  ) {
    roleFilter = roleRaw as string[];
  }

  // --- Search parameters (mutually exclusive) ---
  const queryStr =
    typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined;
  const queryRegexStr =
    typeof args.queryRegex === "string" && args.queryRegex.trim()
      ? args.queryRegex.trim()
      : undefined;
  if (queryStr && queryRegexStr) {
    return {
      resultJson: JSON.stringify({
        error: "query and queryRegex are mutually exclusive; provide only one",
      }),
    };
  }
  // Validate regex early to avoid runtime crashes
  let compiledRegex: RegExp | undefined;
  if (queryRegexStr) {
    try {
      compiledRegex = new RegExp(queryRegexStr, "i");
    } catch (e) {
      return {
        resultJson: JSON.stringify({
          error: `invalid queryRegex pattern: ${String(e)}`,
        }),
      };
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
    roleFilter.forEach((r, i) => {
      params[`role_${i}`] = r;
    });
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
    seq: number;
    role: string;
    content: string | null;
    tool_call_id: string | null;
    tool_calls_json: string | null;
    metadata_json: string | null;
    session_id: string;
    created_at: string | null;
  };
  let rows = stmt.all(params) as RawRow[];

  // JS-side regex filter + pagination when needed
  if (compiledRegex) {
    rows = rows.filter((r) => r.content != null && compiledRegex!.test(r.content));
    const startIdx =
      order === "desc"
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
      const indexRows = countStmt.all({ sid }) as {
        seq: number;
        idx: number;
      }[];
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

/**
 * Agent id for a spawn from the builtin subagent tool. An explicit `agent_id`
 * argument wins; otherwise derive a unique slug (e.g. `developer-2`) from the
 * calling session's agent id. The reservation set mirrors the control-plane
 * `subagent_spawn` op: configured top-level agent ids, the parent's own agent
 * id, and every active subagent id. (#459 made `agent_id` required on spawn,
 * but the builtin tool schema never exposed it, so callers could not supply
 * one; deriving here restores tool spawns without weakening the control
 * contract.)
 */
function resolveSpawnAgentId(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
  sessions: SessionStore,
): string {
  const supplied = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  if (supplied) return supplied;
  const parentId = resolveAgentIdFromSessionId(ctx.sessionId);
  const reserved = new Set(Object.keys(ctx.config.agents?.list ?? {}));
  if (parentId) reserved.add(parentId);
  for (const row of sessions.list())
    if (row.status !== "terminated" && row.subagentAgentId) reserved.add(row.subagentAgentId);
  return deriveThreadSubagentAgentId(parentId || "subagent", (id) => reserved.has(id));
}

async function subagentHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const inv = ctx.getAgentIntegrationInvoker();
  if (!inv) {
    return {
      resultJson: JSON.stringify({ error: "subagent_control_unavailable" }),
    };
  }
  // Nesting gate: a session may use subagent ops only while its depth in the
  // subagent tree is below maxSpawnDepth (default 1 — top-level sessions only).
  // Depth is computed by walking parent-session lineage, not URN shape. The
  // control-op layer re-checks this authoritatively on spawn.
  const sessions = createSessionStore(ctx.db);
  const depth = computeSessionDepthFromStore(sessions, ctx.sessionId);
  const agentId = resolveAgentIdFromSessionId(ctx.sessionId);
  if (!maySpawnSubagentAtDepth(depth, effectiveMaxSpawnDepth(ctx.config, agentId))) {
    return {
      resultJson: JSON.stringify({ error: "subagent_tool_depth_exceeded" }),
    };
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
    payload.agent_id = resolveSpawnAgentId(args, ctx, sessions);
    if (args.internal === false) payload.internal = false;
    if (args.background === true) payload.background = true;
    const dm = args.delivery_mode;
    if (dm === "inline" || dm === "queue" || dm === "drop") payload.delivery_mode = dm;
    // Wall-clock TTL in minutes (positive integer), mirroring inactivity_minutes
    // on persistent spawns; the control op clamps it to runtime.maxTtlMs.
    const tmin = args.ttl_minutes;
    if (typeof tmin === "number" && Number.isFinite(tmin) && tmin > 0) {
      payload.ttl_minutes = Math.trunc(tmin);
    }
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
    const im = args.inactivity_minutes;
    if (typeof im === "number" && Number.isFinite(im) && im > 0) {
      payload.inactivity_minutes = Math.trunc(im);
    }
    const respondTo = args.respond_to;
    if (typeof respondTo === "string" && respondTo.trim()) {
      payload.respond_to = respondTo.trim();
    }
    if (args.internal === false) payload.internal = false;
    const tn = args.thread_name;
    if (typeof tn === "string" && tn.trim()) payload.thread_name = tn.trim();
    payload.agent_id = resolveSpawnAgentId(args, ctx, sessions);
    const dm2 = args.delivery_mode;
    if (dm2 === "inline" || dm2 === "queue" || dm2 === "drop") payload.delivery_mode = dm2;
  } else if (action === "inspect") {
    op = "session_inspect";
    payload = { session_id: ctx.sessionId };
  } else if (action === "steer") {
    const sid = String(args.session_id ?? "").trim();
    const prompt = String(args.prompt ?? "").trim();
    if (!sid || !prompt) {
      return {
        resultJson: JSON.stringify({ error: "session_id and prompt required" }),
      };
    }
    if (!isDirectSubagentChild(sessions, ctx.sessionId, sid, false)) {
      return {
        resultJson: JSON.stringify({ error: "subagent_target_not_child" }),
      };
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
    if (!isDirectSubagentChild(sessions, ctx.sessionId, sid, true)) {
      return {
        resultJson: JSON.stringify({ error: "subagent_target_not_child" }),
      };
    }
    op = "session_abort";
    payload = { session_id: sid };
  } else if (action === "kill") {
    const sid = String(args.session_id ?? "").trim();
    if (!sid) {
      return { resultJson: JSON.stringify({ error: "session_id required" }) };
    }
    if (!isDirectSubagentChild(sessions, ctx.sessionId, sid, false)) {
      return {
        resultJson: JSON.stringify({ error: "subagent_target_not_child" }),
      };
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
        resultJson: JSON.stringify({
          error: "session_ids must be a non-empty array of strings",
        }),
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
      resultJson: JSON.stringify({
        error: `unknown subagent action: ${action}`,
      }),
    };
  }

  // model_options for spawn actions
  const mo = args.model_options;
  const spawnAction = action === "spawn_one_shot" || action === "spawn_persistent";
  if (spawnAction && mo && typeof mo === "object" && !Array.isArray(mo)) {
    payload.model_options = mo;
  }

  // enable_tools for spawn actions: tool IDs or glob patterns for the child session
  const enableToolsArg = args.enable_tools;
  if (
    spawnAction &&
    Array.isArray(enableToolsArg) &&
    enableToolsArg.every((x) => typeof x === "string" && x.trim())
  ) {
    payload.enable_tools = (enableToolsArg as string[]).map((x) => x.trim());
  }

  // contract mode for one-shot spawns: array of {path, action, summary};
  // forwarded verbatim and validated authoritatively at the control op.
  if (action === "spawn_one_shot" && args.contract !== undefined && args.contract !== null) {
    payload.contract = args.contract;
  }

  // judge: explicit decision model (provider-id/model-name) for contract judging
  if (action === "spawn_one_shot" && typeof args.judge === "string" && args.judge.trim()) {
    payload.judge = args.judge.trim();
  }

  log.info("subagent invoked", { action, sessionId: ctx.sessionId });
  if (spawnAction) {
    log.info("subagent spawned", {
      action,
      parentSessionId: ctx.sessionId,
      mode: payload.mode,
    });
  }
  const result = await invokeIntegration(inv, ctx.sessionId, op, payload);
  if (spawnAction) {
    let childId: string | undefined;
    try {
      const parsed = JSON.parse(result.resultJson);
      childId = parsed.session_id;
    } catch {
      /* ignore */
    }
    log.info("subagent completed", {
      action,
      childId,
      parentSessionId: ctx.sessionId,
    });
    // Successful spawn: refresh the live subagent counts so the in-flight
    // turn status bar shows the new subagent immediately (not next turn).
    // Inline one-shots are already terminated when their op returns, so
    // they leave the counts unchanged.
    if (childId) {
      ctx.onSubagentsChanged?.(getSessionSubagentCounts(ctx.db, ctx.sessionId));
    }
  }
  return result;
}

/**
 * steer/kill may target only direct children of the invoking session; abort may
 * also target the session itself. Enforced here (not just by same-agent scoping
 * at the control-op layer) so a subagent with spawn privileges can never
 * steer/kill outside its own subtree.
 */
function isDirectSubagentChild(
  sessions: SessionStore,
  parentSessionId: string,
  targetSessionId: string,
  allowSelf: boolean,
): boolean {
  if (allowSelf && targetSessionId === parentSessionId) return true;
  return sessions.getById(targetSessionId)?.parentSessionId === parentSessionId;
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
    return {
      resultJson: JSON.stringify({ error: "subagent_control_unavailable" }),
    };
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

/** Cap on the message preview echoed into notify banners. */
const SESSION_SEND_PREVIEW_CHARS = 120;

/**
 * Effective reply window for a session-send call before it yields: per-call
 * `yieldMs` (`0` = block until the reply arrives, the legacy behavior)
 * overrides the configured default (`runtime.sessionSendYieldMs`, default 30 s;
 * `0` there disables yielding globally). Returns `undefined` when the call
 * should block. Per-call values are capped at the configured max TTL so a
 * window can never stretch toward "forever".
 */
function resolveSendYieldMs(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): number | undefined {
  if (typeof args.yieldMs === "number") {
    if (args.yieldMs <= 0) return undefined;
    return Math.min(args.yieldMs, resolveMaxTtlMs(ctx.config));
  }
  const cfgMs = resolveSessionSendYieldMs(ctx.config);
  return cfgMs > 0 ? cfgMs : undefined;
}

async function sessionSendHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const inv = ctx.getAgentIntegrationInvoker();
  if (!inv) {
    return {
      resultJson: JSON.stringify({ error: "subagent_control_unavailable" }),
    };
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
      resultJson: JSON.stringify({
        error: "set only one of session_id or agent_id",
      }),
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

  // --- Yield + notify (mirrors the background-exec notify mechanism) ---
  // Race the target's turn against the reply window. A reply that lands in
  // time returns inline exactly as before; an expired window hands the pending
  // call off to a notify handle (default) and returns a pending result. The
  // reply is then delivered to the calling session in-turn when a turn is
  // active, out of band otherwise.
  const resultPromise = invokeIntegration(inv, ctx.sessionId, "session_send", payload);
  const yieldMs = resolveSendYieldMs(args, ctx);
  if (yieldMs === undefined) return resultPromise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const yielded = await Promise.race([
    resultPromise.then(
      () => false,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), yieldMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!yielded) return resultPromise;
  const targetSessionId =
    (typeof payload.session_id === "string" ? payload.session_id : undefined) ??
    (typeof payload.agent_id === "string" ? `agent:${payload.agent_id}` : undefined) ??
    "unknown";
  const handle: SessionSendNotifyHandle = {
    id: randomUUID(),
    sessionId: ctx.sessionId,
    targetSessionId,
    message:
      message.length > SESSION_SEND_PREVIEW_CHARS
        ? `${message.slice(0, SESSION_SEND_PREVIEW_CHARS)}…`
        : message,
  };
  const notify = typeof args.notify === "boolean" ? args.notify : true;
  const scheduler = notify ? getSessionSendNotifyScheduler() : undefined;
  if (scheduler) {
    scheduler.register(handle, resultPromise);
  } else {
    // Opted out (notify: false) or no scheduler (e.g. bare test harness): the
    // reply is intentionally dropped; swallow the eventual rejection so it
    // never surfaces as an unhandled rejection.
    void resultPromise.catch(() => undefined);
  }
  // Surface trace for the yield itself (best-effort): post an emoji-stamped
  // banner to the session's bound surface so the operator can see the call
  // stopped blocking, mirroring the OOB notify banners. The later reply
  // delivery carries its own banner, so the two moments stay distinguishable.
  const yieldBanner = scheduler
    ? `> 📨 Session-send yielded: waiting for reply from *${targetSessionId}* \`${handle.id}\` …`
    : `> 📨 Session-send yielded: reply from *${targetSessionId}* will not be delivered (notify disabled)`;
  // Folded into the active turn's output when one is live; standalone
  // post only when no turn surface exists.
  if (!postTurnSurfaceNotice(ctx.sessionId, yieldBanner)) {
    const ext = subagentRuntimeExtensionRef.current;
    void ext?.sendStatusMessage?.(ctx.sessionId, yieldBanner).catch((e) => {
      log.warn("session-send yield banner failed", {
        sessionId: ctx.sessionId,
        err: String(e),
      });
    });
  }
  return {
    resultJson: JSON.stringify({
      status: "pending",
      notify: Boolean(scheduler),
      ...(scheduler ? { notifyId: handle.id } : {}),
      targetSessionId,
      yieldMs,
      note: scheduler
        ? "The reply has not arrived yet; it will be delivered when it does (in-turn if a turn is active, otherwise out of band)."
        : "Notify is disabled: the reply will not be delivered when it arrives.",
    }),
  };
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
