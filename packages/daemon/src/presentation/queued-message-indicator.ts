import type { PlatformCapabilities } from "./platform-adapter";

/**
 * Queued-message indicator (issue #399).
 *
 * When an operator's message lands in the turn queue behind an in-flight turn,
 * the platform marks the message so the operator knows it was received:
 *
 * 1. a ⏳ reaction on the queued message when the platform supports reactions;
 * 2. otherwise a reply ("⏳ Agent is busy; message has been queued.") when the
 *    platform declares reply support;
 * 3. otherwise a standalone post with the same content.
 *
 * The reaction mark is removed via {@link QueuedMessageIndicator.clear} once the
 * queued message is processed or dropped from the queue. Reply/post fallbacks
 * carry nothing to clear.
 */

/** Emoji reaction marking an operator message that is waiting in the turn queue. */
export const QUEUED_MESSAGE_REACTION = "⏳";

/** Fallback notice for platforms that cannot react to the queued message. */
export const QUEUED_MESSAGE_NOTICE = "⏳ Agent is busy; message has been queued.";

/** Minimal logger surface (daemon `Logger` is structurally compatible). */
export interface QueuedMessageIndicatorLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface QueuedMessageIndicatorInput {
  readonly sessionId: string;
  /** Platform message id of the queued message (the reaction target). */
  readonly messageId: string;
  readonly capabilities: PlatformCapabilities;
  /** Resolves the channel/thread hosting `messageId`; reaction transport needs it. */
  readonly resolveChannelId?: (sessionId: string) => string | undefined;
  /** Reply to the queued message; used when reactions are unsupported and the platform declares replies. */
  readonly sendReply?: (body: string) => Promise<void>;
  /** Post a standalone notice; used when the platform supports neither reactions nor replies. */
  readonly sendPost?: (body: string) => Promise<void>;
  readonly logger: QueuedMessageIndicatorLogger;
}

export interface QueuedMessageIndicator {
  /** Flag the message as queued (reaction preferred; reply/post as fallback). Idempotent, fire-and-forget. */
  readonly markQueued: () => void;
  /** Remove the queued mark once the message is processed or dropped. No-op unless a reaction was applied. */
  readonly clear: () => Promise<void>;
}

export function createQueuedMessageIndicator(
  input: QueuedMessageIndicatorInput,
): QueuedMessageIndicator {
  const { logger } = input;
  const reactions = input.capabilities.reactions;
  const channelId = input.resolveChannelId?.(input.sessionId);

  let marked = false;
  /** Resolves when the reaction add attempt has settled (success or failure). */
  let added: Promise<void> | undefined;
  /** Set only when the reaction add succeeded; carries the removal call. */
  let removeReaction: (() => Promise<void>) | undefined;

  function markQueued(): void {
    if (marked) return;
    marked = true;
    if (reactions && channelId) {
      added = reactions.addReaction(channelId, input.messageId, QUEUED_MESSAGE_REACTION).then(
        () => {
          removeReaction = () =>
            reactions.removeReaction(channelId, input.messageId, QUEUED_MESSAGE_REACTION);
        },
        (err: unknown) => {
          logger.warn("queued_indicator.reaction_add_failed", {
            sessionId: input.sessionId,
            messageId: input.messageId,
            err: String(err),
          });
        },
      );
      return;
    }
    if (input.capabilities.replies && input.sendReply) {
      void input.sendReply(QUEUED_MESSAGE_NOTICE).catch((err: unknown) => {
        logger.warn("queued_indicator.reply_failed", {
          sessionId: input.sessionId,
          messageId: input.messageId,
          err: String(err),
        });
      });
      return;
    }
    if (input.sendPost) {
      void input.sendPost(QUEUED_MESSAGE_NOTICE).catch((err: unknown) => {
        logger.warn("queued_indicator.post_failed", {
          sessionId: input.sessionId,
          messageId: input.messageId,
          err: String(err),
        });
      });
    }
  }

  async function clear(): Promise<void> {
    if (!added) return;
    // The turn may finish before the add lands; wait it out so the remove
    // never races ahead of the reaction it is meant to delete.
    await added;
    if (!removeReaction) return;
    try {
      await removeReaction();
    } catch (err) {
      logger.warn("queued_indicator.reaction_remove_failed", {
        sessionId: input.sessionId,
        messageId: input.messageId,
        err: String(err),
      });
    }
  }

  return { markQueued, clear };
}
