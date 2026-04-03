import type { SessionToolLoopFailoverState } from "../sessions/session-tool-loop-model-client";
import {
  executeSessionAgentTurn,
  type ExecuteSessionAgentTurnInput,
  type SessionAgentTurnResult,
} from "../sessions/session-agent-turn";
import type { OutboundAttachment } from "../presentation/platform-adapter";
import { getLogger } from "../logging";

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
  readonly start: () => Promise<{ setFullContent: (body: string) => Promise<void> }>;
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
  readonly formatAssistantReply: (
    latestAssistantText: string,
    failoverMeta: SessionToolLoopFailoverState | undefined,
  ) => string;
  readonly formatErrorReply: (err: unknown) => string;
  /** Used when not streaming, or when streaming failed to start. */
  readonly sendAssistantBody: (body: string, opts?: { attachments?: readonly OutboundAttachment[] }) => Promise<void>;
  readonly sendErrorBody: (body: string) => Promise<void>;
  /**
   * Send attachments as a follow-up message (used after streaming, where the
   * streamed message cannot carry file attachments).
   */
  readonly sendAttachments?: (attachments: readonly OutboundAttachment[]) => Promise<void>;
  readonly mcpLifecycle?: {
    readonly onTurnBegin?: () => void;
    readonly onTurnEnd?: () => void;
  };
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
  const ctx = options.logContext;

  options.mcpLifecycle?.onTurnBegin?.();

  let streamSink: { setFullContent: (body: string) => Promise<void> } | undefined;
  let streamPusher: ReturnType<typeof createCoalescingStreamPusher> | undefined;

  if (streaming) {
    try {
      streamSink = await streaming.start();
      streamPusher = createCoalescingStreamPusher(
        (s) => streamSink!.setFullContent(s),
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
    const turnResult = await executeSessionAgentTurn({
      ...turn,
      stream: streamPusher
        ? {
            streamModel: true,
            onModelTextDelta: (t) => {
              const vis = t.trim() ? t : "…";
              streamPusher!.push(sliceDisplayText(vis));
            },
          }
        : undefined,
    });

    const body = sliceDisplayText(
      formatAssistantReply(turnResult.latestAssistantText, turnResult.failoverMeta),
    );

    const attachments = turnResult.showAttachments;

    if (streamPusher && streamSink) {
      await streamPusher.flush();
      await streamSink.setFullContent(body);
      // Streaming edits can't carry file attachments — send as follow-up.
      if (attachments?.length && options.sendAttachments) {
        try {
          await options.sendAttachments(attachments);
        } catch (e) {
          log.warn("inbound_session_turn.show_attachment_followup_failed", { ...ctx, err: String(e) });
        }
      }
    } else {
      await options.sendAssistantBody(body, attachments?.length ? { attachments } : undefined);
    }
  } catch (e) {
    options.onTurnExecutionFailed?.(e);
    log.warn("inbound_session_turn.failed", { ...ctx, err: String(e) });
    try {
      await options.sendErrorBody(sliceDisplayText(formatErrorReply(e)));
    } catch (sendErr) {
      log.error("inbound_session_turn.error_delivery_failed", {
        ...ctx,
        err: String(sendErr),
      });
    }
  } finally {
    options.mcpLifecycle?.onTurnEnd?.();
  }
}
