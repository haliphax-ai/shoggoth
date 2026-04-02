import type { TieredTurnQueue } from "./session-turn-queue";

let instance: TieredTurnQueue | undefined;

export function getTurnQueue(): TieredTurnQueue {
  if (!instance) throw new Error("TieredTurnQueue not initialized — call setTurnQueue() first");
  return instance;
}

export function setTurnQueue(q: TieredTurnQueue): void {
  instance = q;
}
