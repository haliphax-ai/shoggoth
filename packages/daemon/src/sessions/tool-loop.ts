import type Database from "better-sqlite3";
import {
  sanitizeJsonEscapes,
  type ShoggothHitlConfig,
  type HitlRiskTier,
  type CruiseControlDecision,
} from "@shoggoth/shared";
import type { ChatContentPart } from "@shoggoth/models";
import { StructuredOutputValidationError, STRUCTURED_OUTPUT_TOOL_NAME } from "@shoggoth/models";
import { classifyToolRisk } from "../hitl/risk-classify";
import { requiresHumanApproval } from "../hitl/approval-gate";
import { buildCruiseControlBanner, extractCruiseToolCommand } from "../hitl/cruise-control";
import { resolveCompoundResource, type SubResourceExtractorRegistry } from "../policy/sub-resource";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import type { HitlNotifier } from "../hitl/hitl-notifier";
import type { PendingActionRow, PendingActionsStore } from "../hitl/pending-actions-store";
import type { SystemGatesHook } from "./system-gates";
import type { TranscriptStore } from "./transcript-store";
import type { ToolRunStore } from "./tool-run-store";
import { TurnAbortedError } from "./session-turn-abort";
import { estimateTokens } from "./session-stats-store";
import { toolRefreshNeeded } from "./session-tool-discovery";
import { getLogger } from "../logging";
import { postTurnSurfaceNotice } from "../presentation/active-turn-surface";
import { validateToolArgs } from "./validate-tool-args";
import { registerSteerChannel, drainSteers } from "./steer-channel";
import {
  RunawayBreaker,
  buildRunawayCancelNotice,
  buildRunawaySteerBanner,
  buildRunawaySteerMessage,
  type RunawayVerdict,
} from "./runaway-breaker";

export { TurnAbortedError } from "./session-turn-abort";

export class ToolCallTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Tool call "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = "ToolCallTimeoutError";
  }
}

export interface ToolCallEvent {
  readonly phase: "start" | "end";
  readonly name: string;
  readonly argsJson: string;
  /** Present on "end". */
  readonly runtimeMs?: number;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly argsJson: string;
  /** Gemini thought signature — opaque token that must be echoed back on replay. */
  readonly thoughtSignature?: string;
}

export interface ModelClient {
  complete(): Promise<{
    content: string | null;
    toolCalls: readonly ToolCall[];
    reasoningContent?: string;
  }>;
  /** When set, tool results are fed back so the next `complete()` sees OpenAI-style tool messages. */
  pushToolMessage?(input: { toolCallId: string; content: string }): void;
  /** When set, injects a steer (operator guidance) message into the model context. */
  pushSteerMessage?(content: string): void;
}

export interface ToolExecutor {
  execute(input: {
    name: string;
    argsJson: string;
    toolCallId: string;
  }): Promise<{ resultJson: string; contentParts?: ChatContentPart[] }>;
}

export interface ToolLoopPolicy {
  check(ctx: {
    toolName: string;
    sessionId: string;
    principalId: string;
    argsJson: string;
  }): { allow: true } | { allow: false; reason: string };
}

export interface ToolLoopAudit {
  record(entry: unknown): void;
}

export interface RunToolLoopHitl {
  readonly config: ShoggothHitlConfig;
  readonly bypassUpTo: HitlRiskTier;
  readonly pending: PendingActionsStore;
  readonly clock: { readonly nowMs: () => number };
  readonly newPendingId: () => string;
  /** Resolves when the pending row is approved, denied, or timed out (DB + {@link PendingActionsStore.expireDue}). */
  readonly waitForHitlResolution: (pendingId: string) => Promise<"approved" | "denied">;
  /** Invoked after a row is enqueued (operator alerts / logs). */
  readonly hitlNotifier?: HitlNotifier;
  /**
   * Optional follow-up after enqueue (e.g. in-thread notice). Errors are swallowed by the tool loop.
   */
  readonly afterHitlQueued?: (row: PendingActionRow) => void | Promise<void>;
  /**
   * When set (e.g. platform ♾️/✅ reactions), matching session/agent **for this tool name** skips HITL.
   */
  readonly autoApprove?: HitlAutoApproveGate;
  /**
   * Cruise control (HITL auto-pilot): when set and active for the session,
   * requests that do not pass auto-approvals are judged (approve / deny /
   * escalate) before being queued for true HITL. Escalations and judge
   * failures fall through to the normal HITL queue.
   */
  readonly cruiseControl?: {
    readonly isActive: (sessionId: string) => boolean;
    readonly judge: (input: {
      readonly sessionId: string;
      readonly toolName: string;
      readonly argsJson: string;
    }) => Promise<CruiseControlDecision>;
  };
}

export interface RunToolLoopOptions {
  readonly db: Database.Database;
  readonly sessionId: string;
  readonly runId: string;
  readonly principalId: string;
  readonly policy: ToolLoopPolicy;
  readonly audit: ToolLoopAudit;
  readonly model: ModelClient;
  readonly tools: ReadonlyArray<{
    name: string;
    inputSchema?: Record<string, unknown>;
  }>;
  readonly executor: ToolExecutor;
  readonly toolRuns: ToolRunStore;
  readonly transcript?: TranscriptStore;
  /** Required when `transcript` is set; must match the session row's `contextSegmentId`. */
  readonly contextSegmentId?: string;
  /** When set, tools above the effective role bypass tier enqueue here instead of executing. */
  readonly hitl?: RunToolLoopHitl;
  /** When aborted (e.g. `session_abort`), the loop exits between hops; in-flight HTTP/tool work may finish first. */
  readonly turnAbortSignal?: AbortSignal;
  /** When set, tool names are resolved to compound resources (e.g. `exec:curl`) before policy/HITL checks. */
  readonly subResourceRegistry?: SubResourceExtractorRegistry;
  /** Maximum milliseconds a single tool call may run. When exceeded the call is killed and a timeout error is injected. */
  readonly toolCallTimeoutMs?: number;
  /** Called after each model.complete() and tool execution for incremental stats updates. */
  readonly onStatsUpdate?: (update: ToolLoopStatsUpdate) => void;
  /**
   * When set, called to refresh the tool name allowlist after a tool discovery change.
   * Returns the new tool list; the loop updates its internal `names` set.
   */
  readonly refreshTools?: () => ReadonlyArray<{
    name: string;
    inputSchema?: Record<string, unknown>;
  }>;
  /** When set, configurable system gates (AGENTS.md / re-read) run before HITL and after execution. */
  readonly systemGates?: SystemGatesHook;
  /**
   * Runaway agent circuit breaker tuning. Enabled by default (identical
   * tool calls repeated past the duplicate threshold steer once, then
   * cancel the turn); pass `false` to disable entirely.
   */
  readonly runawayBreaker?:
    | false
    | {
        readonly windowSize?: number;
        readonly maxDuplicates?: number;
        readonly signatureArgsChars?: number;
        readonly proseCharLimit?: number;
      };
  /**
   * Fired around executor.execute for calls that proceed to execution (not policy-denied,
   * HITL-queued, or validation-skipped dispatches). "start" then "end" per executed call.
   */
  readonly onToolCallEvent?: (ev: ToolCallEvent) => void;
}

/** Callback payload for incremental stats updates during the tool loop. */
export interface ToolLoopStatsUpdate {
  /** Token delta from a single model.complete() call. */
  readonly tokenDelta?: {
    inputTokens: number;
    outputTokens: number;
    contextWindowTokens?: number;
  };
  /** Estimated tokens from tool call argsJson / tool result resultJson to add to input tokens. */
  readonly estimatedInputTokens?: number;
  /** Transcript message count changed (absolute count to set). */
  readonly transcriptMessageCount?: number;
}

// ---------------------------------------------------------------------------
// Dispatch result – returned by `processSingleToolCall` so the caller can
// decide whether to skip or proceed with the next tool call.
// ---------------------------------------------------------------------------

/** Discriminant for the per-tool-call dispatch result. */
export type ToolCallDispatchResultKind =
  | "skip_invalid_name"
  | "skip_thinking_leak"
  | "skip_unknown_tool"
  | "skip_structured_output_near_miss"
  | "skip_bad_args"
  | "skip_validation_error"
  | "skip_policy_denied"
  | "skip_review_unavailable"
  | "skip_system_gated"
  | "skip_hitl_denied"
  | "proceed";

export interface ToolCallDispatchResult {
  readonly kind: ToolCallDispatchResultKind;
  /** Present when kind === "proceed" – the resolved compound resource name. */
  readonly compoundResource?: string;
}

// ---------------------------------------------------------------------------
// Shared loop context – bundles the recurring dependencies so helper
// function signatures stay concise.
// ---------------------------------------------------------------------------

interface ToolLoopContext {
  readonly options: RunToolLoopOptions;
  readonly appendTx: (row: {
    role: string;
    content?: string | null;
    toolCallId?: string | null;
    toolCalls?: readonly { id: string; name: string; argsJson: string }[];
    metadata?: unknown;
  }) => void;
  readonly emitStats: RunToolLoopOptions["onStatsUpdate"];
  readonly getTranscriptCount: () => number;
}

// ---------------------------------------------------------------------------
// Utility helpers – private, file-scoped
// ---------------------------------------------------------------------------

const allowedNames = (tools: ReadonlyArray<{ name: string }>) => new Set(tools.map((t) => t.name));

const buildSchemaMap = (
  tools: ReadonlyArray<{ name: string; inputSchema?: Record<string, unknown> }>,
) => {
  const m = new Map<string, Record<string, unknown>>();
  for (const t of tools) {
    if (t.inputSchema) m.set(t.name, t.inputSchema);
  }
  return m;
};

/** Maximum number of structured output validation retries before giving up. */
const STRUCTURED_OUTPUT_MAX_RETRIES = 2;

/**
 * Backstop for consecutive invalid tool calls within a single turn.
 *
 * The model loop is `for (;;)` and only exits on abort, a terminal no-tool-call
 * response, or the structured-output retry budget. A model that repeatedly emits
 * invalid tool calls (and never recovers) would spin forever, so we cap
 * consecutive invalid dispatches. "Invalid" here means an unknown tool name, a
 * known tool called with unparseable arguments, or a known tool called with
 * schema-invalid arguments — all three are calls the model could retry forever
 * without the loop ever advancing. When this many occur in a row without a valid
 * tool call or terminal response in between, the turn is terminated cleanly
 * (same `break` style as the retry-exhausted path). Near-miss structured-output
 * calls are excluded: they have their own bounded retry budget above.
 */
const MAX_CONSECUTIVE_INVALID_TOOL_CALLS = 5;

/**
 * Detect a near-miss of the synthetic structured-output tool name.
 *
 * Models under stress sometimes emit a garbled variant — e.g.
 * `__structured_output__parameter` — that contains the exact synthetic name as a
 * substring. The provider adapters match the synthetic tool with an exact-name
 * check (`isSyntheticToolCall`), so these near-misses fall through to the
 * daemon's generic unknown-tool path, which has no counter and would let the
 * `for (;;)` loop spin unbounded. Routing them into the structured-output retry
 * budget (instead) bounds the spin. Deliberately simple: exact-name-substring
 * containment, excluding the exact name itself (which the adapter intercepts).
 */
function isNearMissStructuredOutputTool(name: string): boolean {
  return name !== STRUCTURED_OUTPUT_TOOL_NAME && name.includes(STRUCTURED_OUTPUT_TOOL_NAME);
}

const HITL_EXPIRE_POLL_MS = 1000;

const log = getLogger("tool-loop");

function assertNotAborted(sig: AbortSignal | undefined): void {
  if (sig?.aborted) throw new TurnAbortedError();
}

function truncate(s: string, max = 100): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.reject(new TurnAbortedError());
  return new Promise((_, rej) => {
    signal.addEventListener("abort", () => rej(new TurnAbortedError()), {
      once: true,
    });
  });
}

/**
 * Fold the cruise control decision banner into the active turn's output
 * (in-place via the turn surface). Silently skipped when the turn has no
 * live output surface; the decision itself is unaffected.
 */
function postCruiseBanner(
  sessionId: string,
  decision: CruiseControlDecision,
  toolName: string,
  argsJson: string,
): void {
  const command = extractCruiseToolCommand(argsJson);
  postTurnSurfaceNotice(
    sessionId,
    buildCruiseControlBanner({ decision, toolName, ...(command ? { command } : {}) }),
  );
}

// ---------------------------------------------------------------------------
// HITL approval gate
// ---------------------------------------------------------------------------

/**
 * Manages the full HITL approval lifecycle for a single tool call:
 * classifies risk, enqueues a pending action, waits for resolution,
 * and handles auto-approve / deny / timeout.
 *
 * @returns `true` when the tool call is approved (or no approval needed).
 *          `false` when the call was denied – the caller should `continue`.
 */
async function hitlApprovalGate(
  ctx: ToolLoopContext,
  compoundResource: string,
  tc: { id: string; name: string; argsJson: string },
  requiresReview: boolean,
  turnAbortSignal: AbortSignal | undefined,
  runId: string,
): Promise<boolean> {
  const { options, appendTx } = ctx;
  const h = options.hitl!;

  h.pending.expireDue(new Date(h.clock.nowMs()).toISOString());
  const tier = classifyToolRisk(compoundResource, h.config.toolRisk);
  const bypass = h.bypassUpTo;
  const needsApproval = requiresHumanApproval(tier, bypass);
  const autoApproved =
    needsApproval &&
    tier !== "never" &&
    h.autoApprove?.shouldAutoApprove(options.sessionId, compoundResource);
  if (autoApproved) {
    log.info("hitl auto-approve fired", {
      toolName: compoundResource,
      sessionId: options.sessionId,
    });
  }
  if (!(requiresReview || (needsApproval && (tier === "never" || !autoApproved)))) {
    return true; // No approval needed
  }

  // Cruise control: requests that did not pass auto-approvals are routed to
  // the decision judge before being queued for true HITL. Approvals execute;
  // denials are pushed back to the model like an operator denial; escalations
  // (and judge failures) fall through to the normal HITL queue.
  if (!autoApproved && h.cruiseControl?.isActive(options.sessionId)) {
    let cruiseDecision: CruiseControlDecision = "escalate";
    try {
      cruiseDecision = await Promise.race([
        h.cruiseControl.judge({
          sessionId: options.sessionId,
          toolName: compoundResource,
          argsJson: tc.argsJson,
        }),
        abortPromise(turnAbortSignal),
      ]);
    } catch (err) {
      log.warn("hitl cruise judge failed; escalating to HITL", {
        toolName: compoundResource,
        sessionId: options.sessionId,
        err: String(err),
      });
      cruiseDecision = "escalate";
    }
    options.audit.record({
      phase: "hitl_cruise_decision",
      tool: compoundResource,
      toolCallId: tc.id,
      decision: cruiseDecision,
      riskTier: tier,
    });
    // In-place verdict banner: folded into the active turn's output so the
    // operator sees the decision where it happens.
    postCruiseBanner(options.sessionId, cruiseDecision, compoundResource, tc.argsJson);
    if (cruiseDecision === "approve") {
      log.info("hitl cruise control approved", {
        toolName: compoundResource,
        sessionId: options.sessionId,
      });
      return true;
    }
    if (cruiseDecision === "deny") {
      const errBody = JSON.stringify({
        error: "hitl_denied",
        reason: "cruise",
      });
      options.audit.record({
        phase: "hitl_denied",
        tool: compoundResource,
        toolCallId: tc.id,
        denialReason: "cruise",
      });
      log.info("hitl cruise control denied", {
        toolName: compoundResource,
        sessionId: options.sessionId,
      });
      options.model.pushToolMessage?.({
        toolCallId: tc.id,
        content: errBody,
      });
      if (options.transcript) {
        appendTx({
          role: "tool",
          content: errBody,
          toolCallId: tc.id,
          metadata: { tool: tc.name },
        });
      }
      return false;
    }
    // "escalate" — fall through to true HITL below.
  }

  const pendingId = h.newPendingId();
  const expiresAtIso = new Date(h.clock.nowMs() + h.config.defaultApprovalTimeoutMs).toISOString();
  h.pending.enqueue({
    id: pendingId,
    sessionId: options.sessionId,
    toolName: compoundResource,
    payload: { argsJson: tc.argsJson, toolCallId: tc.id },
    riskTier: tier,
    expiresAtIso,
    correlationId: runId,
  });
  options.audit.record({
    phase: "hitl_queued",
    tool: compoundResource,
    toolCallId: tc.id,
    pendingId,
    riskTier: tier,
  });
  log.info("hitl approval requested", {
    toolName: compoundResource,
    sessionId: options.sessionId,
    pendingId,
    riskTier: tier,
  });

  const queuedRow = h.pending.getById(pendingId);
  if (queuedRow) {
    h.hitlNotifier?.onQueued(queuedRow);
    void Promise.resolve(h.afterHitlQueued?.(queuedRow)).catch(() => {});
  }

  const expireTimer = setInterval(() => {
    h.pending.expireDue(new Date(h.clock.nowMs()).toISOString());
  }, HITL_EXPIRE_POLL_MS);
  try {
    h.pending.expireDue(new Date(h.clock.nowMs()).toISOString());
    const outcome = await Promise.race([
      h.waitForHitlResolution(pendingId),
      abortPromise(turnAbortSignal),
    ]);
    if (outcome === "denied") {
      const row = h.pending.getById(pendingId);
      const reason = row?.denialReason === "timeout" ? "timeout" : "operator";
      const errBody = JSON.stringify({
        error: "hitl_denied",
        pendingId,
        reason,
      });
      options.audit.record({
        phase: "hitl_denied",
        tool: compoundResource,
        toolCallId: tc.id,
        pendingId,
        denialReason: reason,
      });
      log.info("hitl approval denied", {
        pendingId,
        toolName: compoundResource,
        reason,
      });
      // Without pushToolMessage, the next model.complete() must not re-emit the same tool
      // call or the outer for (;;) will spin (HITL re-queue + wait forever).
      options.model.pushToolMessage?.({
        toolCallId: tc.id,
        content: errBody,
      });
      if (options.transcript) {
        appendTx({
          role: "tool",
          content: errBody,
          toolCallId: tc.id,
          metadata: { tool: tc.name },
        });
      }
      return false;
    }
  } finally {
    clearInterval(expireTimer);
  }
  log.info("hitl approval granted", {
    pendingId,
    toolName: compoundResource,
    sessionId: options.sessionId,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Per-tool-call dispatch
// ---------------------------------------------------------------------------

/**
 * Validates, gates (policy + HITL), and executes a single tool call.
 *
 * Returns a {@link ToolCallDispatchResult} so the caller knows whether to
 * `continue` (skip) or proceed with execution.  Errors and denials are
 * pushed back to the model via `pushToolMessage` and appended to the
 * transcript inside this function.
 *
 * The function is organized into distinct stages:
 *   1. Name / thinking-leak / unknown-tool validation
 *   2. Args validation
 *   3. Policy check
 *   4. HITL approval gate
 *   5. Execution with timeout
 *   6. Result feedback to model + transcript
 */
async function processSingleToolCall(
  ctx: ToolLoopContext,
  tc: { id: string; name: string; argsJson: string; thoughtSignature?: string },
  names: Set<string>,
  schemas: Map<string, Record<string, unknown>>,
  badArgIds: Set<string>,
  turnAbortSignal: AbortSignal | undefined,
  runId: string,
): Promise<ToolCallDispatchResult> {
  const { options, appendTx } = ctx;

  log.debug("tool call received", {
    toolName: tc.name,
    toolCallId: tc.id,
    sessionId: options.sessionId,
    args: truncate(tc.argsJson, 1000),
  });

  // Estimate argsJson tokens (becomes part of next model input context)
  ctx.emitStats?.({ estimatedInputTokens: estimateTokens(tc.argsJson) });
  assertNotAborted(turnAbortSignal);

  // ---- Stage 1: name / thinking-leak / unknown-tool validation ----

  const VALID_TOOL_NAME = /^[a-zA-Z0-9_\-:.]{1,128}$/;
  if (typeof tc.name !== "string" || !VALID_TOOL_NAME.test(tc.name)) {
    log.warn("invalid tool name", {
      toolName: typeof tc.name === "string" ? tc.name.slice(0, 80) : "<missing>",
      toolCallId: tc.id,
      sessionId: options.sessionId,
    });
    const errBody = JSON.stringify({
      error: "invalid_tool_name",
      message: "Tool name contains invalid characters or exceeds 128 chars.",
    });
    options.audit.record({ phase: "invalid_tool_name", toolCallId: tc.id });
    options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
    if (options.transcript) {
      appendTx({
        role: "tool",
        content: errBody,
        toolCallId: tc.id,
        metadata: { tool: "_invalid_" },
      });
    }
    return { kind: "skip_invalid_name" };
  }

  // Detect thinking content leaked into tool call names.
  const THINKING_LEAK_RE = /^(?:thinking|think)[_\s]/i;
  if (THINKING_LEAK_RE.test(tc.name)) {
    log.warn("thinking content leaked into tool name", {
      toolName: tc.name.slice(0, 80),
      toolCallId: tc.id,
      sessionId: options.sessionId,
    });
    options.audit.record({ phase: "thinking_leak", toolCallId: tc.id });
    options.model.pushToolMessage?.({
      toolCallId: tc.id,
      content: JSON.stringify({ ok: true, note: "acknowledged" }),
    });
    return { kind: "skip_thinking_leak" };
  }

  if (!names.has(tc.name)) {
    // Near-miss of the synthetic structured-output tool (e.g.
    // `__structured_output__parameter`): do NOT take the generic unknown-tool
    // path, which is unbounded. Hand the model a correction naming the EXACT
    // tool and flag it so the caller charges the structured-output retry budget
    // and terminates the turn once that budget is exhausted.
    if (isNearMissStructuredOutputTool(tc.name)) {
      log.warn("near-miss structured output tool call", {
        toolName: tc.name,
        toolCallId: tc.id,
        sessionId: options.sessionId,
      });
      const correction = JSON.stringify({
        error: "structured_output_tool_near_miss",
        tool: tc.name,
        message:
          `You called "${tc.name}", which is not a real tool. ` +
          `The structured-output tool is named exactly "${STRUCTURED_OUTPUT_TOOL_NAME}". ` +
          `Call it alone with a single JSON object whose arguments conform to the ` +
          `JSON schema provided in that tool's definition.`,
      });
      options.audit.record({
        phase: "structured_output_tool_near_miss",
        tool: tc.name,
        toolCallId: tc.id,
      });
      options.model.pushToolMessage?.({ toolCallId: tc.id, content: correction });
      if (options.transcript) {
        appendTx({
          role: "tool",
          content: correction,
          toolCallId: tc.id,
          metadata: { tool: tc.name },
        });
      }
      return { kind: "skip_structured_output_near_miss" };
    }
    log.warn("unknown tool called", {
      toolName: tc.name,
      toolCallId: tc.id,
      sessionId: options.sessionId,
    });
    const errBody = JSON.stringify({
      error: "unknown_tool",
      tool: tc.name,
      message: `Unknown tool: ${tc.name}. It may not be available in this session.`,
    });
    options.audit.record({
      phase: "unknown_tool",
      tool: tc.name,
      toolCallId: tc.id,
    });
    options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
    if (options.transcript) {
      appendTx({
        role: "tool",
        content: errBody,
        toolCallId: tc.id,
        metadata: { tool: tc.name },
      });
    }
    return { kind: "skip_unknown_tool" };
  }

  if (badArgIds.has(tc.id)) {
    const errBody = JSON.stringify({
      error: "invalid_arguments",
      tool: tc.name,
      message: "Tool call arguments were not valid JSON.",
    });
    options.audit.record({
      phase: "args_parse_error",
      tool: tc.name,
      toolCallId: tc.id,
    });
    options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
    if (options.transcript) {
      appendTx({
        role: "tool",
        content: errBody,
        toolCallId: tc.id,
        metadata: { tool: tc.name },
      });
    }
    return { kind: "skip_bad_args" };
  }

  // ---- Stage 2: args validation ----

  const toolArgs = JSON.parse(tc.argsJson) as Record<string, unknown>;
  const toolSchema = schemas.get(tc.name);
  if (toolSchema) {
    const validationErrors = validateToolArgs(toolArgs, toolSchema);
    if (validationErrors.length > 0) {
      const detail = validationErrors.map((e) => `${e.field}: ${e.message}`).join("; ");
      log.warn("tool call args validation failed", {
        toolName: tc.name,
        toolCallId: tc.id,
        sessionId: options.sessionId,
        detail,
      });
      const errBody = JSON.stringify({
        error: "invalid_arguments",
        tool: tc.name,
        message: `Argument validation failed: ${detail}`,
      });
      options.audit.record({
        phase: "args_validation_error",
        tool: tc.name,
        toolCallId: tc.id,
        detail,
      });
      options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
      if (options.transcript) {
        appendTx({
          role: "tool",
          content: errBody,
          toolCallId: tc.id,
          metadata: { tool: tc.name },
        });
      }
      return { kind: "skip_validation_error" };
    }
  }

  const compoundResource = options.subResourceRegistry
    ? resolveCompoundResource(tc.name, toolArgs, options.subResourceRegistry)
    : tc.name;

  // ---- Stage 3: policy check ----

  const decision = options.policy.check({
    toolName: compoundResource,
    sessionId: options.sessionId,
    principalId: options.principalId,
    argsJson: tc.argsJson,
  });

  options.audit.record({
    phase: "policy",
    tool: compoundResource,
    toolCallId: tc.id,
    argsJson: tc.argsJson,
    decision,
  });

  const requiresReview = !decision.allow && decision.reason === "requires_review";

  // Deny is a HARD BLOCK (operator ruling): an immediate error result back
  // into the tool loop — NO HITL queue entry, no approval latency. Only the
  // review tier queues human sign-off; risk-tier HITL below is unchanged.
  if (!decision.allow && !requiresReview) {
    log.warn("tool call policy denied", {
      toolName: compoundResource,
      toolCallId: tc.id,
      sessionId: options.sessionId,
      reason: decision.reason,
    });
    const errBody = JSON.stringify({
      error: "policy_denied",
      tool: compoundResource,
      message:
        decision.reason === "explicit_deny"
          ? `policy_denied: tool '${compoundResource}' is deny-listed`
          : `Tool call denied by policy: ${decision.reason}`,
    });
    options.audit.record({
      phase: "policy_denied",
      tool: compoundResource,
      toolCallId: tc.id,
      reason: decision.reason,
    });
    options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
    if (options.transcript) {
      appendTx({
        role: "tool",
        content: errBody,
        toolCallId: tc.id,
        metadata: { tool: tc.name },
      });
    }
    return { kind: "skip_policy_denied" };
  }

  if (requiresReview && !options.hitl) {
    log.warn("tool call requires review but no HITL configured", {
      toolName: compoundResource,
      toolCallId: tc.id,
      sessionId: options.sessionId,
    });
    const errBody = JSON.stringify({
      error: "review_required",
      tool: compoundResource,
      message: `Tool call requires human approval but no review system is configured.`,
    });
    options.audit.record({
      phase: "review_unavailable",
      tool: compoundResource,
      toolCallId: tc.id,
    });
    options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
    if (options.transcript) {
      appendTx({
        role: "tool",
        content: errBody,
        toolCallId: tc.id,
        metadata: { tool: tc.name },
      });
    }
    return { kind: "skip_review_unavailable" };
  }

  // ---- Stage 3.5: system gates (AGENTS.md / re-read for configured tools) ----
  // Runs BEFORE HITL so an approval-worthy external tool is gated first —
  // otherwise the operator approves a tool that then gets gated, and the
  // model's retry triggers a second HITL prompt.

  if (options.systemGates) {
    const gated = await options.systemGates.pre({
      toolName: tc.name,
      args: toolArgs,
      toolCallId: tc.id,
    });
    if (gated) {
      options.audit.record({
        phase: "system_gated",
        tool: compoundResource,
        toolCallId: tc.id,
      });
      options.model.pushToolMessage?.({
        toolCallId: tc.id,
        content: gated.resultJson,
      });
      if (options.transcript) {
        appendTx({
          role: "tool",
          content: gated.resultJson,
          toolCallId: tc.id,
          metadata: { tool: tc.name },
        });
      }
      return { kind: "skip_system_gated" };
    }
  }

  // ---- Stage 4: HITL approval gate ----

  if (options.hitl) {
    const approved = await hitlApprovalGate(
      ctx,
      compoundResource,
      tc,
      requiresReview,
      turnAbortSignal,
      runId,
    );
    if (!approved) {
      return { kind: "skip_hitl_denied" };
    }
  }

  // ---- Stage 5: execute with timeout ----

  options.audit.record({
    phase: "execute_start",
    tool: compoundResource,
    toolCallId: tc.id,
    argsJson: tc.argsJson,
  });

  assertNotAborted(turnAbortSignal);
  const t0 = Date.now();
  log.debug("tool call started", {
    toolName: compoundResource,
    toolCallId: tc.id,
    sessionId: options.sessionId,
  });

  // Fired only for calls that proceed to execution (not policy-denied,
  // HITL-queued, or validation-skipped dispatches).
  options.onToolCallEvent?.({
    phase: "start",
    name: compoundResource,
    argsJson: tc.argsJson,
  });

  const execPromise = options.executor.execute({
    name: tc.name,
    argsJson: tc.argsJson,
    toolCallId: tc.id,
  });
  let out: { resultJson: string; contentParts?: ChatContentPart[] };
  const timeoutMs = options.toolCallTimeoutMs;
  try {
    if (timeoutMs != null && timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new ToolCallTimeoutError(compoundResource, timeoutMs)), timeoutMs);
      });
      out = await Promise.race([execPromise, timeoutPromise, abortPromise(turnAbortSignal)]);
    } else {
      out = await Promise.race([execPromise, abortPromise(turnAbortSignal)]);
    }
  } catch (e) {
    if (e instanceof TurnAbortedError) throw e;
    if (e instanceof ToolCallTimeoutError) {
      log.warn("tool call timed out", {
        toolName: compoundResource,
        toolCallId: tc.id,
        sessionId: options.sessionId,
        timeoutMs,
      });
      const errBody = JSON.stringify({
        error: "tool_call_timeout",
        tool: compoundResource,
        timeoutMs,
      });
      options.audit.record({
        phase: "execute_timeout",
        tool: compoundResource,
        toolCallId: tc.id,
        timeoutMs,
      });
      options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
      if (options.transcript) {
        appendTx({
          role: "tool",
          content: errBody,
          toolCallId: tc.id,
          metadata: { tool: tc.name },
        });
      }
      return { kind: "skip_hitl_denied" }; // reuse skip kind – caller continues
    }
    // General tool execution error — inject back to model so it can react.
    const errMsg = e instanceof Error ? e.message : String(e);
    log.warn("tool call failed", {
      toolName: compoundResource,
      toolCallId: tc.id,
      sessionId: options.sessionId,
      error: errMsg,
    });
    const errBody = JSON.stringify({
      error: "tool_call_error",
      tool: compoundResource,
      message: errMsg,
    });
    options.audit.record({
      phase: "execute_error",
      tool: compoundResource,
      toolCallId: tc.id,
      error: errMsg,
    });
    options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
    if (options.transcript) {
      appendTx({
        role: "tool",
        content: errBody,
        toolCallId: tc.id,
        metadata: { tool: tc.name },
      });
    }
    return { kind: "skip_hitl_denied" }; // reuse skip kind – caller continues
  }

  log.debug("tool call completed", {
    toolName: compoundResource,
    toolCallId: tc.id,
    sessionId: options.sessionId,
    durationMs: Date.now() - t0,
    success: true,
  });

  options.onToolCallEvent?.({
    phase: "end",
    name: compoundResource,
    argsJson: tc.argsJson,
    runtimeMs: Date.now() - t0,
  });

  // ---- Stage 5.5: system gates post-execution producer ----
  // Re-read line-shift detection for configured external tools. Never runs on
  // timeout/error paths; the factory deletes its snapshot internally.

  if (options.systemGates) {
    try {
      await options.systemGates.post({
        toolName: tc.name,
        args: toolArgs,
        toolCallId: tc.id,
        resultJson: out.resultJson,
      });
    } catch (e) {
      log.warn("system gates post hook failed; ignoring", {
        toolName: compoundResource,
        toolCallId: tc.id,
        sessionId: options.sessionId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---- Stage 6: result feedback to model + transcript ----

  const toolMessageContent = out.contentParts ? JSON.stringify(out.contentParts) : out.resultJson;

  options.audit.record({
    phase: "execute_done",
    tool: compoundResource,
    toolCallId: tc.id,
    resultJson: out.resultJson,
  });

  options.model.pushToolMessage?.({
    toolCallId: tc.id,
    content: toolMessageContent,
  });

  ctx.emitStats?.({
    estimatedInputTokens: estimateTokens(toolMessageContent),
  });

  if (options.transcript) {
    appendTx({
      role: "tool",
      content: toolMessageContent,
      toolCallId: tc.id,
      metadata: { tool: tc.name },
    });
    ctx.emitStats?.({ transcriptMessageCount: ctx.getTranscriptCount() });
  }

  return { kind: "proceed", compoundResource };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runToolLoop(options: RunToolLoopOptions): Promise<void> {
  void options.db;
  let names = allowedNames(options.tools);
  let schemas = buildSchemaMap(options.tools);
  const ctxSeg = options.contextSegmentId?.trim() ?? "";
  if (options.transcript && !ctxSeg) {
    throw new Error("runToolLoop: contextSegmentId is required when transcript is set");
  }
  const appendTx = (row: {
    role: string;
    content?: string | null;
    toolCallId?: string | null;
    toolCalls?: readonly { id: string; name: string; argsJson: string }[];
    metadata?: unknown;
  }) => {
    if (!options.transcript) return;
    options.transcript.append({
      sessionId: options.sessionId,
      contextSegmentId: ctxSeg,
      role: row.role,
      content: row.content,
      toolCallId: row.toolCallId,
      toolCalls: row.toolCalls,
      metadata: row.metadata,
    });
  };

  options.toolRuns.insertRunning({
    id: options.runId,
    sessionId: options.sessionId,
  });

  const steerHandle = registerSteerChannel(options.sessionId);

  const emitStats = options.onStatsUpdate;
  const getTranscriptCount = (): number =>
    (
      options.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM transcript_messages WHERE session_id = @sessionId AND context_segment_id = @ctxSeg`,
        )
        .get({ sessionId: options.sessionId, ctxSeg }) as { cnt: number }
    ).cnt;

  // Shared context passed to helper functions
  const ctx: ToolLoopContext = { options, appendTx, emitStats, getTranscriptCount };

  try {
    let structuredOutputAttempt = 0;
    // Runaway agent circuit breaker (per-turn): steers a repeating tool-call
    // pattern once, then cancels the turn on a second trigger. Opt-out via
    // `runawayBreaker: false`.
    const runawayBreaker =
      options.runawayBreaker === false
        ? undefined
        : new RunawayBreaker(options.runawayBreaker ?? {});

    /**
     * Shared steer/cancel handling for both runaway heuristics (duplicate
     * tool calls, excessive prose). Returns true when the turn must be
     * canceled — the caller sets `breakerTripped` and unwinds.
     */
    const handleRunawayVerdict = (runaway: RunawayVerdict): boolean => {
      if (runaway.verdict === "ok") return false;
      const trigger = runaway.trigger;
      if (runaway.verdict === "steer") {
        const steerMsg = buildRunawaySteerMessage(trigger);
        log.warn("runaway circuit breaker steered", {
          sessionId: options.sessionId,
          trigger,
        });
        options.audit.record({
          phase: "runaway_breaker_steer",
          sessionId: options.sessionId,
          trigger,
        });
        options.model.pushSteerMessage?.(steerMsg);
        postTurnSurfaceNotice(options.sessionId, buildRunawaySteerBanner(trigger));
        if (options.transcript) {
          appendTx({
            role: "user",
            content: steerMsg,
            metadata: { runawayBreakerSteer: true },
          });
          emitStats?.({ transcriptMessageCount: getTranscriptCount() });
        }
        return false;
      }
      const notice = buildRunawayCancelNotice(trigger);
      log.error("runaway circuit breaker canceled turn", {
        sessionId: options.sessionId,
        trigger,
      });
      options.audit.record({
        phase: "runaway_breaker_cancel",
        sessionId: options.sessionId,
        trigger,
      });
      postTurnSurfaceNotice(options.sessionId, notice);
      if (options.transcript) {
        appendTx({
          role: "assistant",
          content: notice,
          metadata: { runawayBreakerCancel: true },
        });
        emitStats?.({ transcriptMessageCount: getTranscriptCount() });
      }
      return true;
    };
    // Consecutive invalid tool calls (unknown name, unparseable args, or
    // schema-invalid args) within the current turn; reset on any valid call or
    // other non-invalid dispatch and on a terminal response.
    let consecutiveInvalidToolCalls = 0;
    for (;;) {
      assertNotAborted(options.turnAbortSignal);

      // ---- Model call ----
      let turn: {
        content: string | null;
        toolCalls: readonly ToolCall[];
        reasoningContent?: string;
      };
      try {
        turn = await Promise.race([
          options.model.complete(),
          abortPromise(options.turnAbortSignal),
        ]);
      } catch (e) {
        if (e instanceof StructuredOutputValidationError) {
          structuredOutputAttempt++;
          log.warn("structured output validation failed", {
            sessionId: options.sessionId,
            attempt: structuredOutputAttempt,
            error: e.message,
            // Provider stop reason; `length` = response truncated mid-generation
            // (e.g. tool-call args cut off at the output-token limit).
            finishReason: e.finishReason ?? null,
          });
          options.audit.record({
            phase: "structured_output_validation_failed",
            sessionId: options.sessionId,
            attempt: structuredOutputAttempt,
          });
          // Record the non-conformant response in transcript
          if (options.transcript) {
            appendTx({
              role: "assistant",
              content: e.rawContent,
              metadata: { structuredOutputValidationFailed: true },
            });
            emitStats?.({ transcriptMessageCount: getTranscriptCount() });
          }
          if (structuredOutputAttempt > STRUCTURED_OUTPUT_MAX_RETRIES) {
            log.error("structured output validation retries exhausted", {
              sessionId: options.sessionId,
              attempts: structuredOutputAttempt,
            });
            // Retry budget spent: stop and let the model's last attempt bubble
            // up as the turn's terminal response (it was just written to the
            // transcript) instead of failing the whole turn. Callers such as
            // OOB delivery then parse it — or surface it verbatim — rather
            // than retrying forever.
            break;
          }
          // Build and inject correction message
          const correction = `Your previous response did not conform to the required JSON schema. Error: ${e.message}\n\nPlease retry and ensure your response conforms to the schema:\n${JSON.stringify(e.schema, null, 2)}`;
          options.model.pushSteerMessage?.(correction);
          // Record correction in transcript
          if (options.transcript) {
            appendTx({
              role: "user",
              content: correction,
              metadata: { structuredOutputCorrection: true },
            });
            emitStats?.({ transcriptMessageCount: getTranscriptCount() });
          }
          continue;
        }
        throw e;
      }

      // ---- Terminal response (no tool calls) ----
      if (turn.toolCalls.length === 0) {
        if (options.transcript && turn.content) {
          appendTx({
            role: "assistant",
            content: turn.content,
            metadata: turn.reasoningContent
              ? { reasoningContent: turn.reasoningContent }
              : undefined,
          });
          emitStats?.({ transcriptMessageCount: getTranscriptCount() });
        }
        // Reset retry counter on successful terminal response
        structuredOutputAttempt = 0;
        consecutiveInvalidToolCalls = 0;
        break;
      }

      // Set when a circuit breaker fires inside the per-tool-call loop; the
      // outer `for (;;)` is then broken after the inner loop unwinds so the
      // turn terminates cleanly (retry-exhausted / backstop style).
      let breakerTripped:
        | "structured_output_exhausted"
        | "invalid_tool_call_backstop"
        | "runaway_cancel"
        | undefined;

      // --- Runaway prose budget ---
      // The hop continues the loop (it carries tool calls), so its prose is
      // charged against the turn's budget — a runaway monologue is prose
      // generated hop after hop without concluding. A terminal response is
      // the turn's deliverable and is never charged.
      if (runawayBreaker && turn.content) {
        if (handleRunawayVerdict(runawayBreaker.recordProse(turn.content.length))) {
          breakerTripped = "runaway_cancel";
          break;
        }
      }

      // ---- Per-tool-call dispatch ----

      // Sanitize malformed argsJson before transcript storage.
      const badArgIds = new Set<string>();
      const sanitizedToolCalls = turn.toolCalls.map((tc) => {
        if (typeof tc.argsJson !== "string") {
          // Malformed tool call (provider omitted `arguments`): treat as bad
          // args so the model receives a structured tool error and the turn
          // completes — never crash the loop inside args sanitization.
          log.warn("tool call args missing", {
            toolName: typeof tc.name === "string" ? tc.name : "<missing>",
            toolCallId: tc.id,
            sessionId: options.sessionId,
          });
          badArgIds.add(tc.id);
          return { ...tc, argsJson: "{}" };
        }
        const fixedArgs = sanitizeJsonEscapes(tc.argsJson);
        try {
          JSON.parse(fixedArgs);
          return fixedArgs !== tc.argsJson ? { ...tc, argsJson: fixedArgs } : tc;
        } catch {
          log.warn("tool call args sanitized", {
            toolName: tc.name,
            toolCallId: tc.id,
            sessionId: options.sessionId,
          });
          badArgIds.add(tc.id);
          return { ...tc, argsJson: "{}" };
        }
      });

      if (options.transcript) {
        appendTx({
          role: "assistant",
          content: turn.content ?? null,
          toolCalls: sanitizedToolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            argsJson: tc.argsJson,
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          })),
          metadata: turn.reasoningContent ? { reasoningContent: turn.reasoningContent } : undefined,
        });
        emitStats?.({ transcriptMessageCount: getTranscriptCount() });
      }

      for (const tc of sanitizedToolCalls) {
        const dispatch = await processSingleToolCall(
          ctx,
          tc,
          names,
          schemas,
          badArgIds,
          options.turnAbortSignal,
          options.runId,
        );

        if (dispatch.kind === "skip_structured_output_near_miss") {
          // Charge the structured-output retry budget (shared with the
          // schema-failure path) and terminate the turn once it's spent.
          structuredOutputAttempt++;
          log.warn("structured output near-miss counted against retry budget", {
            sessionId: options.sessionId,
            attempt: structuredOutputAttempt,
            toolName: tc.name,
          });
          if (structuredOutputAttempt > STRUCTURED_OUTPUT_MAX_RETRIES) {
            log.error("structured output near-miss retries exhausted", {
              sessionId: options.sessionId,
              attempts: structuredOutputAttempt,
            });
            breakerTripped = "structured_output_exhausted";
            break;
          }
        } else if (
          dispatch.kind === "skip_unknown_tool" ||
          dispatch.kind === "skip_bad_args" ||
          dispatch.kind === "skip_validation_error"
        ) {
          // All invalid tool calls — unknown name, unparseable args, or
          // schema-invalid args on a known tool — count toward the backstop,
          // since the model could retry each forever without advancing.
          consecutiveInvalidToolCalls++;
          if (consecutiveInvalidToolCalls > MAX_CONSECUTIVE_INVALID_TOOL_CALLS) {
            log.error("consecutive invalid tool calls exceeded backstop; terminating turn", {
              sessionId: options.sessionId,
              consecutive: consecutiveInvalidToolCalls,
              lastKind: dispatch.kind,
            });
            options.audit.record({
              phase: "invalid_tool_call_backstop",
              sessionId: options.sessionId,
              consecutive: consecutiveInvalidToolCalls,
              lastKind: dispatch.kind,
            });
            breakerTripped = "invalid_tool_call_backstop";
            break;
          }
        } else {
          // A valid tool call (or any other non-invalid-args skip kind) resets
          // the consecutive invalid-tool-call counter.
          consecutiveInvalidToolCalls = 0;
        }

        // --- Runaway agent circuit breaker ---
        // Records every call that actually EXECUTED (post-dispatch `proceed`):
        // a repeating pattern (same tool + same truncated args within a
        // rolling window) steers once; a second trigger cancels the turn and
        // raises a warning that rides the normal transcript delivery path.
        // Calls that never dispatched (unknown tool, bad args, …) are left to
        // the consecutive-invalid backstop above.
        if (runawayBreaker && dispatch.kind === "proceed") {
          if (handleRunawayVerdict(runawayBreaker.record(tc.name, tc.argsJson))) {
            breakerTripped = "runaway_cancel";
            break;
          }
        }

        // --- Mid-loop tool refresh (tool discovery) ---
        if (toolRefreshNeeded.get(options.sessionId) && options.refreshTools) {
          toolRefreshNeeded.delete(options.sessionId);
          const refreshed = options.refreshTools();
          names = allowedNames(refreshed);
          schemas = buildSchemaMap(refreshed);
          log.debug("tool list refreshed mid-loop", {
            sessionId: options.sessionId,
            toolCount: refreshed.length,
          });
        }
      }

      // A circuit breaker fired: end the turn (mirrors the retry-exhausted
      // `break` above) so the loop can never spin forever.
      if (breakerTripped) break;

      // --- Mid-loop steer injection ---
      for (const s of drainSteers(options.sessionId)) {
        log.info("steering message injected into active tool loop", {
          sessionId: options.sessionId,
          message: s,
        });
        options.model.pushSteerMessage?.(s);
        // Persist the steer in the transcript so it survives the turn and is
        // available to context assembly on subsequent turns.
        if (options.transcript) {
          appendTx({
            role: "user",
            content: s,
            metadata: { steer: true },
          });
          emitStats?.({ transcriptMessageCount: getTranscriptCount() });
        }
      }
    }

    options.toolRuns.markCompleted(options.runId);
    steerHandle.unregister();
  } catch (e) {
    steerHandle.unregister();
    const row = options.db
      .prepare(`SELECT status FROM tool_runs WHERE id = ?`)
      .get(options.runId) as { status: string } | undefined;
    if (row?.status === "running") {
      const reason = e instanceof TurnAbortedError ? "aborted" : `error:${String(e)}`;
      options.toolRuns.markFailed(options.runId, reason);
    }
    throw e;
  }
}
