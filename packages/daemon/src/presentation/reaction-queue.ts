export interface QueuedReaction {
  readonly messageId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly emoji: { readonly id: string | null; readonly name: string | null };
  readonly receivedAt: number; // Date.now()
}

/**
 * Per-session streaming reaction queue.
 * While a response is in-flight, reactions to any of its message IDs are held.
 * On completion, they are drained for processing. On failure/timeout, they are discarded.
 */
export class ReactionQueue {
  private inFlight = new Map<string, Set<string>>();
  private queued = new Map<string, QueuedReaction[]>();

  /** Mark a message ID as part of an in-flight response for a session. */
  trackMessage(sessionId: string, messageId: string): void {
    let ids = this.inFlight.get(sessionId);
    if (!ids) {
      ids = new Set<string>();
      this.inFlight.set(sessionId, ids);
    }
    ids.add(messageId);
  }

  /** Check if a message ID is part of an in-flight response. */
  isInFlight(sessionId: string, messageId: string): boolean {
    const ids = this.inFlight.get(sessionId);
    return ids ? ids.has(messageId) : false;
  }

  /** Queue a reaction for later processing. */
  enqueue(sessionId: string, reaction: QueuedReaction): void {
    let list = this.queued.get(sessionId);
    if (!list) {
      list = [];
      this.queued.set(sessionId, list);
    }
    list.push(reaction);
  }

  /** Response completed — drain all queued reactions for this session and clear tracking. */
  drain(sessionId: string): QueuedReaction[] {
    const reactions = this.queued.get(sessionId) ?? [];
    this.queued.delete(sessionId);
    this.inFlight.delete(sessionId);
    return reactions;
  }

  /** Response failed/timed out — discard all queued reactions and clear tracking. */
  discard(sessionId: string): void {
    this.queued.delete(sessionId);
    this.inFlight.delete(sessionId);
  }

  /** Visible for testing. */
  _reset(): void {
    this.inFlight.clear();
    this.queued.clear();
  }
}
