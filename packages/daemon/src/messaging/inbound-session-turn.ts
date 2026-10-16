import type { SessionToolLoopFailoverState } from "../sessions/session-tool-loop-model-client";
import { createSessionStore } from "../sessions/session-store";
import { deliverSubagentResult } from "../control/integration-ops";
import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { shouldSkipThreadSessionSentinel } from "../subagent/thread-subagent-autocreate";
import {
  executeSessionAgentTurn,
  type ExecuteSessionAgentTurnInput,
} from "../sessions/session-agent-turn";
import type { ToolCallEvent } from "../sessions/tool-loop";
import type { OutboundAttachment, StreamHandle } from "../presentation/platform-adapter";
import { getLogger } from "../logging";
import { createThinkingOutput } from "./thinking-output";

const log = getLogger("inbound-session-turn");

/**
 * Coalesces high-frequency model token updates into occasional `setFull` calls (rate-limit friendly).
 * Always call {@link flush} before the final body patch.
 */
export function createCoalescingStreamPusher(
  setFull: (body: string) => Promise<void>,
  minIntervalMs: number,
): {
  push: (text: string) => void;
  flush: () => Promise<void>;
} {
  let latest = "";
  let lastSent = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  function push(text: string) {
    latest = text;
    const now = Date.now();
    if (minIntervalMs <= 0 || now - lastSent >= minIntervalMs) {
      lastSent = now;
      chain = chain.then(() => setFull(latest)).catch(() => {});
      return;
    }
    if (timeout) clearTimeout(timeout);
    const wait = minIntervalMs - (now - lastSent);
    timeout = setTimeout(() => {
      timeout = undefined;
      lastSent = Date.now();
      chain = chain.then(() => setFull(latest)).catch(() => {});
    }, wait);
  }

  async function flush() {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    await chain;
    lastSent = Date.now();
    await setFull(latest);
  }

  return { push, flush };
}

export interface InboundSessionTurnStreaming {
  readonly minIntervalMs: number;
  readonly start: () => Promise<{
    setFullContent: (body: string) => Promise<void>;
    pushUpdate: (body: string) => Promise<void>;
  }>;
  readonly onStartFailed?: (message: string) => void;
}

export type InboundSessionTurnInput = Omit<ExecuteSessionAgentTurnInput, "stream">;

export interface RunInboundSessionTurnOptions {
  /**
   * Build turn input after lifecycle `onTurnBegin` (e.g. resolve MCP catalog) so failures still run
   * `onTurnEnd`.
   */
  readonly buildTurn: () => Promise<InboundSessionTurnInput>;
  readonly streaming?: InboundSessionTurnStreaming;
  /** Transport limits / normalization applied to stream chunks and final bodies. */
  readonly sliceDisplayText: (text: string) => string;
  /** Include model reasoning in user-visible output when enabled by the platform config. */
  readonly showThinking?: boolean;
  readonly formatAssistantReply: (
    latestAssistantText: string,
    failoverMeta: SessionToolLoopFailoverState | undefined,
  ) => string;
  readonly formatErrorReply: (err: unknown) => string;
  /** Used when not streaming, or when streaming failed to start. */
  readonly sendAssistantBody: (
    body: string,
    opts?: { attachments?: readonly OutboundAttachment[] },
  ) => Promise<void>;
  readonly sendErrorBody: (body: string) => Promise<void>;
  /**
   * Send attachments as a follow-up message (used after streaming, where the
   * streamed message cannot carry file attachments).
   */
  readonly sendAttachments?: (attachments: readonly OutboundAttachment[]) => Promise<void>;
  /**
   * Optional status bar factory; wired at turn start when the platform surface supports it.
   * `create` returns the tracker sink for this turn's delivery, or `undefined` to skip (e.g.
    readonly enabled: boolean;
   * non-messaging-surface delivery where no in-flight message can carry a bar).
   */
  readonly statusBar?: {
    readonly enabled: boolean;
    /**
     * Wraps the streaming handle right after start so the in-flight message
     * carries `setStatusBar` (live mid-turn bar). Returns the augmented handle.
     */
    readonly attachSink?: (h: StreamHandle) => StreamHandle;
    readonly create: () => Promise<
      | {
          readonly setStatusBar: (line: string | null) => Promise<void>;
          /** Terminal render (✅/🛑/❌); returns the rendered bar line for delivery. */
          readonly finish: (outcome: string) => Promise<string | undefined>;
          /** Assistant prose is streaming from the model (💬). */
          readonly onProse?: (accumulated: string) => void;
          /** Reasoning/thinking content is streaming from the model. */
          readonly onThinkingDelta?: (accumulated: string) => void;
          readonly onToolCall?: (ev: ToolCallEvent) => void;
          /** A HITL approval row was queued for a tool call (⏸️). */
          readonly onHitlQueued?: (call: { name: string; argsJson: string }) => void;
          /** A mid-turn compaction completed. */
          readonly onCompaction?: () => void;
          /** A model call reported usage: live context-window fill update. */
          readonly onContextUpdate?: (update: {
            readonly currentTokens: number;
            readonly totalTokens?: number;
          }) => void;
          /** A subagent spawn succeeded mid-turn: fresh active counts. */
          readonly onSubagentsChanged?: (counts: {
            readonly total: number;
            readonly persistent: number;
          }) => void;
          /** A timer was queued or cancelled mid-turn: fresh unfired count. */
          readonly onTimersChanged?: (count: number) => void;
        }
      | undefined
    >;
  };
  readonly mcpLifecycle?: {
    readonly onTurnBegin?: () => void;
    readonly onTurnEnd?: () => void;
  };
  /**
   * When set, the returned promise settles as soon as `executeSessionAgentTurn`
   * settles and post-turn delivery (status bar finish, stream flush, final body
   * send, persistent-subagent delivery) runs detached, so a hung platform edit
   * cannot hold the session's turn-queue entry open.
   */
  readonly detachPostTurnDelivery?: boolean;
  readonly logContext?: Record<string, string | undefined>;
  /** Observed before {@link sendErrorBody} (e.g. transport-specific log keys). */
  readonly onTurnExecutionFailed?: (err: unknown) => void;
}

/**
 * Single entry point for an inbound-triggered session agent turn: MCP lifecycle hooks, optional
 * coalesced streaming, {@link executeSessionAgentTurn}, and success/error delivery.
 */
export async function runInboundSessionTurn(options: RunInboundSessionTurnOptions): Promise<void> {
  const { streaming, sliceDisplayText, formatAssistantReply, formatErrorReply } = options;
  const thinkingOutput = options.showThinking ? createThinkingOutput() : undefined;
  const ctx = options.logContext;

  options.mcpLifecycle?.onTurnBegin?.();

  let streamSink:
    | {
        setFullContent: (body: string) => Promise<void>;
        pushUpdate: (body: string) => Promise<void>;
        /** Present when the platform augments the handle (attachSink) with a live bar sink. */
        setStatusBar?: (line: string | null) => Promise<void>;
      }
    | undefined;
  let streamPusher: ReturnType<typeof createCoalescingStreamPusher> | undefined;
  let statusBar:
    | {
        setStatusBar: (line: string | null) => Promise<void>;
        finish: (outcome: string) => Promise<string | undefined>;
        onProse?: (accumulated: string) => void;
        onThinkingDelta?: (accumulated: string) => void;
        onToolCall?: (ev: ToolCallEvent) => void;
        onHitlQueued?: (call: { name: string; argsJson: string }) => void;
        onCompaction?: () => void;
        onContextUpdate?: (update: { currentTokens: number; totalTokens?: number }) => void;
        onSubagentsChanged?: (counts: { total: number; persistent: number }) => void;
        onTimersChanged?: (count: number) => void;
      }
    | undefined;

  // Create the status bar tracker at turn start when the platform surface
  // enables it. `create` resolves to undefined for non-messaging-surface
  // delivery, where no in-flight message can carry a bar — skip entirely then.
  if (options.statusBar?.enabled) {
    try {
      statusBar = await options.statusBar.create();
    } catch (e) {
      log.warn("inbound_session_turn.status_bar_create_failed", {
        ...ctx,
        err: String(e),
      });
      statusBar = undefined;
    }
  }
  if (streaming) {
    try {
      streamSink = await streaming.start();
      // Live mid-turn bar: let the status bar option wrap the handle so its
      // sink can apply renders to the in-flight message while the turn runs.
      streamSink = options.statusBar?.attachSink?.(streamSink) ?? streamSink;
      streamPusher = createCoalescingStreamPusher(
        (s) => streamSink!.pushUpdate(s),
        streaming.minIntervalMs,
      );
    } catch (e) {
      const msg = String(e);
      streaming.onStartFailed?.(msg);
      streamSink = undefined;
      streamPusher = undefined;
    }
  }

  try {
    const turn = await options.buildTurn();

    // Thread sentinel (core inbound path, upstream of the turn): a thread-bound
    // subagent session ignores a leading inbound message that is only "." while it
    // has no transcript history yet — lets the operator set the thread up (e.g.
    // switch the model) before submitting a real prompt. The session stays bound and
    // later messages fire turns normally.
    if (
      turn.db &&
      turn.sessionId &&
      typeof turn.userContent === "string" &&
      shouldSkipThreadSessionSentinel({
        db: turn.db,
        sessions: createSessionStore(turn.db),
        sessionId: turn.sessionId,
        body: turn.userContent,
      })
    ) {
      log.debug("inbound_session_turn.thread_sentinel_skipped", {
        sessionId: turn.sessionId,
      });
      return;
    }

    const turnResult = await executeSessionAgentTurn({
      ...turn,
      stream:
        streamPusher || thinkingOutput
          ? {
              // Reasoning callbacks are only provided by model streaming APIs.
              // Request model streaming even when the transport itself is posting
              // at once so the final reply can include the collected reasoning.
              streamModel: true,
              ...(streamPusher
                ? {
                    onModelTextDelta: (t: string) => {
                      const display = thinkingOutput ? thinkingOutput.onText(t) : t;
                      const vis = display.trim() ? display : "…";
                      streamPusher!.push(vis);
                      // Prose phase (💬): the tracker renders live from text deltas.
                      statusBar?.onProse?.(t);
                    },
                  }
                : {}),
            }
          : undefined,
      // Forward status bar events (thinking / tool / hitl / compaction /
      // context fill) into the turn so the tracker can re-render live while
      // the turn executes.
      events:
        statusBar || thinkingOutput
          ? {
              onThinkingDelta: (accumulated) => {
                if (thinkingOutput) {
                  const display = thinkingOutput.onThinking(accumulated);
                  if (streamPusher) streamPusher.push(display.trim() ? display : "…");
                }
                statusBar?.onThinkingDelta?.(accumulated);
              },
              onToolCall: (ev) => statusBar?.onToolCall?.(ev),
              onHitlQueued: (call) => statusBar?.onHitlQueued?.(call),
              onCompaction: () => statusBar?.onCompaction?.(),
              onContextUpdate: (update) => statusBar?.onContextUpdate?.(update),
              onSubagentsChanged: (counts) => statusBar?.onSubagentsChanged?.(counts),
              onTimersChanged: (count) => statusBar?.onTimersChanged?.(count),
            }
          : undefined,
    });

    const deliver = async (): Promise<void> => {
      // All-turn delivery for persistent subagents
      try {
        const row = createSessionStore(turn.db).getById(turn.sessionId);
        if (
          row?.subagentMode === "persistent" &&
          !row.subagentPlatformThreadId &&
          row.subagentDeliveryMode !== "drop" &&
          row.subagentRespondTo
        ) {
          const ext = subagentRuntimeExtensionRef.current;
          if (ext) {
            await deliverSubagentResult(ext, {
              childSessionId: turn.sessionId,
              respondTo: row.subagentRespondTo,
              internalDelivery: true,
              mode: "persistent",
              deliveryMode: row.subagentDeliveryMode ?? "inline",
              assistantText: turnResult.latestAssistantText,
              subLog: log,
              // Thread the turn's model invocation override (e.g. responseSchema for
              // structured output) into the parent delivery turn when present.
              modelInvocationOverride: turn.modelInvocationOverride,
              fallbackRespondTo: row.parentSessionId,
            });
          }
        }
      } catch (e) {
        log.warn("persistent_subagent_delivery.failed", {
          sessionId: turn.sessionId,
          err: String(e),
        });
      }

      const formattedBody = formatAssistantReply(
        turnResult.latestAssistantText,
        turnResult.failoverMeta,
      );
      const rawBody = thinkingOutput?.render(formattedBody) ?? formattedBody;

      const attachments = turnResult.showAttachments;

      // Finish the tracker BEFORE final delivery so the last setFullContent /
      // sendAssistantBody carries the frozen bar line (✅ / 🛑 / ❌).
      let barLine: string | undefined;
      if (statusBar) {
        try {
          barLine = await statusBar.finish(turnResult.outcome);
        } catch (e) {
          log.warn("inbound_session_turn.status_bar_finish_failed", {
            ...ctx,
            err: String(e),
          });
          barLine = undefined;
        }
      }

      const bodyWithBar = barLine ? `${rawBody}\n\n${barLine}` : rawBody;

      if (streamPusher && streamSink) {
        // Flush first: its renders still carry the active terminal bar, so the
        // bar stays visible right up to the final edit. Then clear the in-flight
        // handle's active-bar state — a state-only operation that makes no edit —
        // so the delivery edit below (whose body already appends barLine itself)
        // lands the bar exactly once. A sink failure must never block delivery.
        await streamPusher.flush();
        if (barLine && streamSink.setStatusBar) {
          try {
            await streamSink.setStatusBar(null);
          } catch (clearErr) {
            log.warn("inbound_session_turn.status_bar_clear_failed", {
              ...ctx,
              err: String(clearErr),
            });
          }
        }
        // Pass the full body — setFullContent handles its own message splitting.
        await streamSink.setFullContent(bodyWithBar);
        // Streaming edits can't carry file attachments — send as follow-up.
        if (attachments?.length && options.sendAttachments) {
          try {
            await options.sendAttachments(attachments);
          } catch (e) {
            log.warn("inbound_session_turn.show_attachment_followup_failed", {
              ...ctx,
              err: String(e),
            });
          }
        }
      } else {
        await options.sendAssistantBody(
          sliceDisplayText(bodyWithBar),
          attachments?.length ? { attachments } : undefined,
        );
      }
    };

    if (options.detachPostTurnDelivery) {
      void deliver().catch((err) => {
        log.warn("inbound_session_turn.detached_delivery_failed", {
          ...ctx,
          err: String(err),
        });
      });
    } else {
      await deliver();
    }
  } catch (e) {
    const deliverError = async (): Promise<void> => {
      // Terminal ❌ bar before the error body — finish with "failed" so the tracker
      // freezes; the rendered line is returned for delivery with the error body.
      let barLine: string | undefined;
      if (statusBar) {
        try {
          barLine = await statusBar.finish("failed");
        } catch (barErr) {
          log.warn("inbound_session_turn.status_bar_finish_failed", {
            ...ctx,
            err: String(barErr),
          });
        }
      }
      // finish()'s terminal render flowed through the sink into the in-flight
      // handle's setStatusBar, which keeps the bar as active state and re-applies
      // it on future renders. Clear that state — a state-only operation that makes
      // no edit, so the in-flight message keeps its terminal ❌ bar until the
      // error body lands as a separate message — and never block error delivery.
      if (barLine && streamSink?.setStatusBar) {
        try {
          await streamSink.setStatusBar(null);
        } catch (clearErr) {
          log.warn("inbound_session_turn.status_bar_clear_failed", {
            ...ctx,
            err: String(clearErr),
          });
        }
      }
      options.onTurnExecutionFailed?.(e);
      log.warn("inbound_session_turn.failed", { ...ctx, err: String(e) });
      try {
        const errorBody = barLine ? `${formatErrorReply(e)}\n\n${barLine}` : formatErrorReply(e);
        await options.sendErrorBody(sliceDisplayText(errorBody));
      } catch (sendErr) {
        log.error("inbound_session_turn.error_delivery_failed", {
          ...ctx,
          err: String(sendErr),
        });
      }
    };

    if (options.detachPostTurnDelivery) {
      void deliverError().catch((err) => {
        log.warn("inbound_session_turn.detached_delivery_failed", {
          ...ctx,
          err: String(err),
        });
      });
    } else {
      await deliverError();
    }
  } finally {
    options.mcpLifecycle?.onTurnEnd?.();
  }
}
