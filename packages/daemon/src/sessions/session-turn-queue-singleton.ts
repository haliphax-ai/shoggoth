import { TieredTurnQueue } from "./session-turn-queue";

export type { TieredTurnQueue };

/** @type {TieredTurnQueue | undefined} */
let turnQueueRef: TieredTurnQueue | undefined;

/**
 * Gets the singleton instance of the TieredTurnQueue.
 * @returns {TieredTurnQueue} The turn queue singleton instance.
 * @throws {Error} If the turn queue has not been initialized.
 */
export function getTurnQueue(): TieredTurnQueue {
  if (!turnQueueRef) {
    throw new Error("TurnQueue has not been initialized. Call setTurnQueue() first.");
  }
  return turnQueueRef;
}

/**
 * Sets the singleton instance of the TieredTurnQueue. Must be called early in daemon bootstrap.
 * @param queue The turn queue instance.
 */
export function setTurnQueue(queue: TieredTurnQueue): void {
  turnQueueRef = queue;
}

/**
 * Like {@link getTurnQueue} but returns undefined instead of throwing when the
 * queue has not been initialized (tests, minimal embeds).
 */
export function tryGetTurnQueue(): TieredTurnQueue | undefined {
  return turnQueueRef;
}
