import type { MessagingAdapterCapabilities } from "@shoggoth/messaging";
import type { DiscordBridgeLogger } from "./bridge";
import type { DiscordRestTransport } from "./transport";
import { MissingPermissionsError, NotFoundError } from "./rest-client";
import { appendSyntheticClose } from "./formatting-state";
import { splitDiscordMessage } from "./split-message";
import { mdTableToAscii } from "./table-formatter.js";
import { formatMessageWithThinking, type ThinkingDisplayMode } from "./thinking-formatter";

const DEFAULT_DISCORD_MAX_CONTENT = 2000;
/** Total attempts (first try + retries) for deleting a single overflow message. */
const DELETE_MAX_ATTEMPTS = 3;
/** Exponential backoff base between delete attempts (250ms, 500ms; total added delay ≤ 750ms). */
const DELETE_RETRY_BASE_DELAY_MS = 250;

export interface DiscordStreamingOutboundConfig {
  readonly transport: DiscordRestTransport;
  readonly capabilities: MessagingAdapterCapabilities;
  readonly channelId: string;
  readonly maxContentLength?: number;
  readonly thinkingDisplay?: ThinkingDisplayMode;
  /** Optional logger; used to report overflow deletions abandoned after exhausting retries. */
  readonly logger?: DiscordBridgeLogger;
}

interface OverflowMessage {
  messageId: string;
  content: string;
}

export interface DiscordStreamHandle {
  readonly messageId: string;
  setFullContent(text: string): Promise<void>;
  pushUpdate(text: string): Promise<void>;
  /** Optional: apply the rendered status bar line to the in-flight message. */
  setStatusBar?(line: string | null): Promise<void>;
}

export interface DiscordStreamingOutbound {
  start(): Promise<DiscordStreamHandle>;
}

export function createDiscordStreamingOutbound(
  config: DiscordStreamingOutboundConfig,
): DiscordStreamingOutbound {
  const {
    transport,
    capabilities,
    channelId,
    maxContentLength = DEFAULT_DISCORD_MAX_CONTENT,
    thinkingDisplay,
    logger,
  } = config;

  if (!capabilities.extensions.streamingOutbound) {
    return {
      async start() {
        throw new Error("Streaming outbound not supported for this adapter capability set");
      },
    };
  }

  return {
    async start(): Promise<DiscordStreamHandle> {
      const created = await transport.createMessage(channelId, {
        content: "…",
      });
      const messageId = created.id;
      const overflowMessages = new Map<number, OverflowMessage>();
      /**
       * Per-handle operation mutex. pushUpdate (chain-serialized by the
       * coalescing pusher), setFullContent, and setStatusBar (tracker render
       * timer) can otherwise interleave: concurrent reconcile passes would each
       * see "no overflow message yet" for an index and create duplicate
       * overflow messages with the same chunk — orphans no later pass ever
       * edits or deletes. Every mutating operation runs through this chain.
       */
      let opChain: Promise<unknown> = Promise.resolve();
      const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
        const run = opChain.then(op, op);
        opChain = run.catch(() => {});
        return run;
      };
      /**
       * Permanent-failure circuit breaker. A 404 (message/thread deleted) or
       * 403 (permissions revoked) means this handle's target is gone: every
       * further edit would fail the same way, instantly, forever. The first
       * permanent rejection poisons the handle (logged once at warn) and all
       * subsequent pushUpdate / setFullContent / setStatusBar calls resolve
       * immediately as no-ops with zero REST traffic, so one 404 ends the
       * edit loop instead of becoming its steady state.
       */
      let dead = false;
      const isPermanent = (err: unknown): err is NotFoundError | MissingPermissionsError =>
        err instanceof NotFoundError || err instanceof MissingPermissionsError;
      const poison = (err: NotFoundError | MissingPermissionsError): void => {
        dead = true;
        logger?.warn("discord.streaming.handle_dead", {
          operation: err.operation,
          status: err.status,
          err: String(err),
        });
      };
      /** Serialize an operation; once the handle is dead the operation is a no-op,
       *  and the first permanent rejection poisons the handle instead of
       *  propagating (transient errors still reject to the caller). */
      const enqueueGuarded = (op: () => Promise<void>): Promise<void> =>
        enqueue(async () => {
          if (dead) return;
          try {
            await op();
          } catch (err) {
            if (isPermanent(err)) {
              poison(err);
              return;
            }
            throw err;
          }
        });
      /** Rendered status bar line while a bar is active; null when no bar is set. */
      let _statusBarLine: string | null = null;
      /** Most recently pushed/full body text (formatted, bar excluded). */
      let lastPushedText: string | null = null;

      const reconcileOverflow = async (chunks: string[]): Promise<void> => {
        // Edit original message with first chunk
        await transport.editMessage(channelId, messageId, { content: chunks[0] });

        // Process remaining chunks
        for (let i = 1; i < chunks.length; i++) {
          const existing = overflowMessages.get(i);
          if (existing) {
            // Edit existing overflow message
            if (existing.content !== chunks[i]) {
              await transport.editMessage(channelId, existing.messageId, {
                content: chunks[i],
              });
              overflowMessages.set(i, { messageId: existing.messageId, content: chunks[i] });
            }
          } else {
            // Create new overflow message
            const created = await transport.createMessage(channelId, { content: chunks[i] });
            overflowMessages.set(i, { messageId: created.id, content: chunks[i] });
          }
        }

        // Delete any overflow messages beyond the current chunks
        const keysToDelete: number[] = [];
        for (const [index, _] of overflowMessages) {
          if (index >= chunks.length) {
            keysToDelete.push(index);
          }
        }
        for (const index of keysToDelete) {
          const overflow = overflowMessages.get(index);
          if (overflow) {
            await transport.deleteMessage(channelId, overflow.messageId);
            overflowMessages.delete(index);
          }
        }
      };

      /**
       * Deletes a single overflow message, retrying transient failures with
       * exponential backoff up to a finite limit. Never throws: after
       * exhausting retries the message is abandoned (logged at warn).
       * Returns true when the deletion succeeded.
       */
      const deleteOverflowWithRetry = async (messageId: string): Promise<boolean> => {
        for (let attempt = 1; attempt <= DELETE_MAX_ATTEMPTS; attempt++) {
          if (dead) return false;
          try {
            await transport.deleteMessage(channelId, messageId);
            return true;
          } catch (err) {
            if (isPermanent(err)) {
              // Target is gone (or we can no longer touch it): poison the
              // handle instead of retrying — the retry loop must not become
              // a permanent-error spew.
              poison(err);
              return false;
            }
            if (attempt < DELETE_MAX_ATTEMPTS) {
              await new Promise((resolve) =>
                setTimeout(resolve, DELETE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)),
              );
            } else {
              logger?.warn("discord.streaming.overflow_delete_failed", {
                messageId,
                attempts: DELETE_MAX_ATTEMPTS,
                err: String(err),
              });
            }
          }
        }
        return false;
      };

      /** Split budget while a bar is active: reserve the bar line plus its blank separator. */
      const splitBudget = (line: string | null): number =>
        line === null ? maxContentLength : maxContentLength - (line.length + 2);

      /**
       * Append the active status bar to the last chunk as a blank-line-separated
       * blockquote so it lands once, at the end of the message.
       */
      const applyStatusBar = (chunks: string[], line: string): string[] => {
        if (chunks.length === 0) return chunks;
        const withBar = [...chunks];
        withBar[withBar.length - 1] = withBar[withBar.length - 1] + "\n\n" + line;
        return withBar;
      };

      return {
        messageId,
        async setFullContent(text: string): Promise<void> {
          if (dead) return;
          await enqueueGuarded(async () => {
            let formattedText = text;
            if (thinkingDisplay) {
              formattedText = formatMessageWithThinking(text, thinkingDisplay);
            }
            formattedText = mdTableToAscii(formattedText);
            lastPushedText = formattedText;

            // Incomplete formatting only matters when a status bar will be
            // appended to the rendered text: an open marker/fence would bleed
            // into the bar line. Close it synthetically; the next chunk
            // recomputes state from the raw text, so the close disappears as
            // soon as the real pair completes. Deliberately NOT gated on
            // tracker activity — the delivery-time bar arrives via the
            // statusBar option without a preceding setStatusBar call, and a
            // body left open there would corrupt the bar just the same.
            const renderedText =
              _statusBarLine === null || formattedText === ""
                ? formattedText
                : appendSyntheticClose(formattedText);

            const budget = splitBudget(_statusBarLine);
            const chunks = splitDiscordMessage(renderedText, budget);
            const finalChunks =
              _statusBarLine === null ? chunks : applyStatusBar(chunks, _statusBarLine);
            await reconcileOverflow(finalChunks);
          });
        },
        async pushUpdate(text: string): Promise<void> {
          if (dead) return;
          await enqueueGuarded(async () => {
            let formattedText = text;
            if (thinkingDisplay) {
              formattedText = formatMessageWithThinking(text, thinkingDisplay);
            }
            formattedText = mdTableToAscii(formattedText);
            lastPushedText = formattedText;

            // Incomplete formatting only matters when a status bar will be
            // appended to the rendered text: an open marker/fence would bleed
            // into the bar line. Close it synthetically; the next chunk
            // recomputes state from the raw text, so the close disappears as
            // soon as the real pair completes. Deliberately NOT gated on
            // tracker activity — the delivery-time bar arrives via the
            // statusBar option without a preceding setStatusBar call, and a
            // body left open there would corrupt the bar just the same.
            const renderedText =
              _statusBarLine === null || formattedText === ""
                ? formattedText
                : appendSyntheticClose(formattedText);

            const budget = splitBudget(_statusBarLine);
            const chunks = splitDiscordMessage(renderedText, budget);
            const finalChunks =
              _statusBarLine === null ? chunks : applyStatusBar(chunks, _statusBarLine);

            if (finalChunks.length === 1) {
              // Simple case: update original message only
              await transport.editMessage(channelId, messageId, { content: finalChunks[0] });
              // Delete all overflow messages. Each deletion is retried with
              // backoff a finite number of times; a failure on one message must
              // never abort cleanup of the remaining ones. Entries that still
              // fail after the final attempt are dropped (already logged).
              for (const [index, overflow] of overflowMessages) {
                // Success removes the message; give-up (already logged inside
                // the helper) drops the entry so it is not retried forever.
                await deleteOverflowWithRetry(overflow.messageId);
                overflowMessages.delete(index);
              }
            } else {
              await reconcileOverflow(finalChunks);
            }
          });
        },
        async setStatusBar(line: string | null): Promise<void> {
          if (dead) return;
          // State changes stay synchronous so operations already queued see the
          // latest line; only the render is serialized with the other mutations.
          _statusBarLine = line;
          // A null line is a state-only clear: no re-render. Delivery clears the
          // bar immediately before its final edit (which carries its own bar
          // line), so re-editing here would visibly strip the bar — and force a
          // full-budget re-split — for the duration of the delivery gap.
          if (line === null) return;
          // Re-render the in-flight message so the bar appears without waiting
          // for the next push. Before the first push there is no body text yet,
          // so the bar renders against the "…" placeholder created by start();
          // the turn-start ⏳ flush depends on this to be visible.
          // The enqueued render re-reads state at run time: prose pushed in the
          // meantime wins as the base content, and a clear in the meantime
          // suppresses the bar (never clobbers the newer state).
          await enqueueGuarded(async () => {
            const activeLine = _statusBarLine;
            if (activeLine === null) return;
            const baseText = lastPushedText ?? "…";
            // Synthetic-close incomplete formatting so an open marker/fence
            // cannot bleed into the appended bar (see setFullContent). The
            // raw text stays unmodified in lastPushedText, so the synthetic
            // markers vanish once the next chunk completes the pair.
            const renderedText = baseText === "" ? baseText : appendSyntheticClose(baseText);
            const budget = splitBudget(activeLine);
            const chunks = splitDiscordMessage(renderedText, budget);
            const finalChunks = applyStatusBar(chunks, activeLine);
            await reconcileOverflow(finalChunks);
          });
        },
      };
    },
  };
}
