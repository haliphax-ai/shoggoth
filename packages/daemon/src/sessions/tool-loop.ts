import type Database from "better-sqlite3";
import type { ShoggothHitlConfig, HitlRiskTier } from "@shoggoth/shared";
import type { ChatContentPart } from "@shoggoth/models";
import { classifyToolRisk } from "../hitl/risk-classify";
import { requiresHumanApproval } from "../hitl/approval-gate";
import { resolveCompoundResource, type SubResourceExtractorRegistry } from "../policy/sub-resource";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import type { HitlNotifier } from "../hitl/hitl-notifier";
import type { PendingActionRow, PendingActionsStore } from "../hitl/pending-actions-store";
import type { TranscriptStore } from "./transcript-store";
import type { ToolRunStore } from "./tool-run-store";
import { TurnAbortedError } from "./session-turn-abort";
import { estimateTokens } from "./session-stats-store";
import { toolRefreshNeeded } from "./session-tool-discovery";
import { getLogger } from "../logging";

export { TurnAbortedError } from "./session-turn-abort";

export class ToolCallTimeoutError extends Error {
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`Tool call "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = "ToolCallTimeoutError";
  }
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly argsJson: string;
}

export interface ModelClient {
  complete(): Promise<{
    content: string | null;
    toolCalls: readonly ToolCall[];
  }>;
  /** When set, tool results are fed back so the next `complete()` sees OpenAI-style tool messages. */
  pushToolMessage?(input: { toolCallId: string; content: string }): void;
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
}

export interface RunToolLoopOptions {
  readonly db: Database.Database;
  readonly sessionId: string;
  readonly runId: string;
  readonly principalId: string;
  readonly policy: ToolLoopPolicy;
  readonly audit: ToolLoopAudit;
  readonly model: ModelClient;
  readonly tools: ReadonlyArray<{ name: string }>;
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
  readonly refreshTools?: () => ReadonlyArray<{ name: string }>;
}

/** Callback payload for incremental stats updates during the tool loop. */
export interface ToolLoopStatsUpdate {
  /** Token delta from a single model.complete() call. */
  readonly tokenDelta?: { inputTokens: number; outputTokens: number; contextWindowTokens?: number };
  /** Estimated tokens from tool call argsJson / tool result resultJson to add to input tokens. */
  readonly estimatedInputTokens?: number;
  /** Transcript message count changed (absolute count to set). */
  readonly transcriptMessageCount?: number;
}

const allowedNames = (tools: ReadonlyArray<{ name: string }>) => new Set(tools.map((t) => t.name));

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
    signal.addEventListener("abort", () => rej(new TurnAbortedError()), { once: true });
  });
}

export async function runToolLoop(options: RunToolLoopOptions): Promise<void> {
  void options.db;
  let names = allowedNames(options.tools);
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

  options.toolRuns.insertRunning({ id: options.runId, sessionId: options.sessionId });

  const emitStats = options.onStatsUpdate;
  const getTranscriptCount = (): number =>
    (options.db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_messages WHERE session_id = @sessionId AND context_segment_id = @ctxSeg`,
    ).get({ sessionId: options.sessionId, ctxSeg }) as { cnt: number }).cnt;

  try {
    for (;;) {
      assertNotAborted(options.turnAbortSignal);
      const turn = await Promise.race([
        options.model.complete(),
        abortPromise(options.turnAbortSignal),
      ]);

      if (turn.toolCalls.length === 0) {
        if (options.transcript && turn.content) {
          appendTx({
            role: "assistant",
            content: turn.content,
          });
          emitStats?.({ transcriptMessageCount: getTranscriptCount() });
        }
        break;
      }

      if (options.transcript) {
        appendTx({
          role: "assistant",
          content: turn.content ?? null,
          toolCalls: turn.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            argsJson: tc.argsJson,
          })),
        });
        emitStats?.({ transcriptMessageCount: getTranscriptCount() });
      }

      for (const tc of turn.toolCalls) {
        log.debug("tool call received", { toolName: tc.name, toolCallId: tc.id, sessionId: options.sessionId, args: truncate(tc.argsJson, 200) });
        // Estimate argsJson tokens (becomes part of next model input context)
        emitStats?.({ estimatedInputTokens: estimateTokens(tc.argsJson) });
        assertNotAborted(options.turnAbortSignal);
        if (!names.has(tc.name)) {
          options.toolRuns.markFailed(options.runId, `unknown_tool:${tc.name}`);
          throw new Error(`unknown tool: ${tc.name}`);
        }

        // Resolve compound resource (e.g. exec → exec:curl) for policy/HITL checks.
        const toolArgs = (() => { try { return JSON.parse(tc.argsJson) as Record<string, unknown>; } catch { return {}; } })();
        const compoundResource = options.subResourceRegistry
          ? resolveCompoundResource(tc.name, toolArgs, options.subResourceRegistry)
          : tc.name;

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

        if (!decision.allow && !requiresReview) {
          options.toolRuns.markFailed(options.runId, `policy_denied:${decision.reason}`);
          throw new Error(decision.reason);
        }

        if (requiresReview && !options.hitl) {
          // No HITL configured — treat requires_review as a block
          options.toolRuns.markFailed(options.runId, `policy_denied:${decision.reason}`);
          throw new Error(decision.reason);
        }

        if (options.hitl) {
          const h = options.hitl;
          h.pending.expireDue(new Date(h.clock.nowMs()).toISOString());
          const tier = classifyToolRisk(compoundResource, h.config.toolRisk);
          const bypass = h.bypassUpTo;
          const needsApproval = requiresHumanApproval(tier, bypass);
          const autoApproved = needsApproval && tier !== "never" && h.autoApprove?.shouldAutoApprove(options.sessionId, compoundResource);
          if (autoApproved) {
            log.info("hitl auto-approve fired", { toolName: compoundResource, sessionId: options.sessionId });
          }
          if (
            requiresReview ||
            (needsApproval &&
            (tier === "never" || !autoApproved))
          ) {
            const pendingId = h.newPendingId();
            const expiresAtIso = new Date(
              h.clock.nowMs() + h.config.defaultApprovalTimeoutMs,
            ).toISOString();
            h.pending.enqueue({
              id: pendingId,
              sessionId: options.sessionId,
              toolName: compoundResource,
              payload: { argsJson: tc.argsJson, toolCallId: tc.id },
              riskTier: tier,
              expiresAtIso,
              correlationId: options.runId,
            });
            options.audit.record({
              phase: "hitl_queued",
              tool: compoundResource,
              toolCallId: tc.id,
              pendingId,
              riskTier: tier,
            });
            log.info("hitl approval requested", { toolName: compoundResource, sessionId: options.sessionId, pendingId, riskTier: tier });

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
                abortPromise(options.turnAbortSignal),
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
                log.info("hitl approval denied", { pendingId, toolName: compoundResource, reason });
                // Without pushToolMessage, the next model.complete() must not re-emit the same tool
                // call or the outer for (;;) will spin (HITL re-queue + wait forever).
                options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
                if (options.transcript) {
                  appendTx({
                    role: "tool",
                    content: errBody,
                    toolCallId: tc.id,
                    metadata: { tool: tc.name },
                  });
                }
                continue;
              }
            } finally {
              clearInterval(expireTimer);
            }
            log.info("hitl approval granted", { pendingId, toolName: compoundResource, sessionId: options.sessionId });
          }
        }

        options.audit.record({
          phase: "execute_start",
          tool: compoundResource,
          toolCallId: tc.id,
          argsJson: tc.argsJson,
        });

        assertNotAborted(options.turnAbortSignal);
        const t0 = Date.now();
        log.debug("tool call started", { toolName: compoundResource, toolCallId: tc.id, sessionId: options.sessionId, args: truncate(tc.argsJson) });

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
            out = await Promise.race([execPromise, timeoutPromise, abortPromise(options.turnAbortSignal)]);
          } else {
            out = await Promise.race([execPromise, abortPromise(options.turnAbortSignal)]);
          }
        } catch (e) {
          if (e instanceof TurnAbortedError) throw e;
          if (e instanceof ToolCallTimeoutError) {
            log.warn("tool call timed out", { toolName: compoundResource, toolCallId: tc.id, sessionId: options.sessionId, timeoutMs });
            const errBody = JSON.stringify({ error: "tool_call_timeout", tool: compoundResource, timeoutMs });
            options.audit.record({ phase: "execute_timeout", tool: compoundResource, toolCallId: tc.id, timeoutMs });
            options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
            if (options.transcript) {
              appendTx({ role: "tool", content: errBody, toolCallId: tc.id, metadata: { tool: tc.name } });
            }
            continue;
          }
          // General tool execution error — inject back to model so it can react.
          const errMsg = e instanceof Error ? e.message : String(e);
          log.warn("tool call failed", { toolName: compoundResource, toolCallId: tc.id, sessionId: options.sessionId, error: errMsg });
          const errBody = JSON.stringify({ error: "tool_call_error", tool: compoundResource, message: errMsg });
          options.audit.record({ phase: "execute_error", tool: compoundResource, toolCallId: tc.id, error: errMsg });
          options.model.pushToolMessage?.({ toolCallId: tc.id, content: errBody });
          if (options.transcript) {
            appendTx({ role: "tool", content: errBody, toolCallId: tc.id, metadata: { tool: tc.name } });
          }
          continue;
        }
        log.debug("tool call completed", { toolName: compoundResource, toolCallId: tc.id, sessionId: options.sessionId, durationMs: Date.now() - t0, success: true });

        // When contentParts is present, serialize as JSON for transcript storage and model feedback.
        const toolMessageContent = out.contentParts
          ? JSON.stringify(out.contentParts)
          : out.resultJson;

        options.audit.record({
          phase: "execute_done",
          tool: compoundResource,
          toolCallId: tc.id,
          resultJson: out.resultJson,
        });

        options.model.pushToolMessage?.({ toolCallId: tc.id, content: toolMessageContent });

        // Estimate resultJson tokens (becomes part of next model input context)
        emitStats?.({ estimatedInputTokens: estimateTokens(toolMessageContent) });

        if (options.transcript) {
          appendTx({
            role: "tool",
            content: toolMessageContent,
            toolCallId: tc.id,
            metadata: { tool: tc.name },
          });
          emitStats?.({ transcriptMessageCount: getTranscriptCount() });
        }

        // --- Mid-loop tool refresh (tool discovery) ---
        if (toolRefreshNeeded.get(options.sessionId) && options.refreshTools) {
          toolRefreshNeeded.delete(options.sessionId);
          const refreshed = options.refreshTools();
          names = allowedNames(refreshed);
          log.debug("tool list refreshed mid-loop", { sessionId: options.sessionId, toolCount: refreshed.length });
        }
      }
    }

    options.toolRuns.markCompleted(options.runId);
  } catch (e) {
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
