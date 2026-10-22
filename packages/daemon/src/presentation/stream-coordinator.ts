/**
 * Platform-agnostic coalescing stream pusher.
 *
 * Batches rapid text updates so the downstream sink (message edit, etc.)
 * is called at most once per `minIntervalMs`.
 */

interface CoalescingStreamPusher {
  push(text: string): void;
  flush(): Promise<void>;
  /**
   * Stop producing: drop further pushes, cancel the pending coalescing timer,
   * and make in-flight/late scheduled dispatches and flush() no-ops. Used when
   * the turn is aborted while the model call is still streaming — the turn
   * promise may never settle, so nothing else would ever stop the edits.
   */
  stop(): void;
}

export function createCoalescingStreamPusher(
  setFull: (body: string) => Promise<void>,
  minIntervalMs: number,
): CoalescingStreamPusher {
  let latest = "";
  let lastSent = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  function push(text: string) {
    if (stopped) return;
    latest = text;
    const now = Date.now();
    if (minIntervalMs <= 0 || now - lastSent >= minIntervalMs) {
      lastSent = now;
      chain = chain.then(() => (stopped ? undefined : setFull(latest))).catch(() => {});
      return;
    }
    if (timeout) clearTimeout(timeout);
    const wait = minIntervalMs - (now - lastSent);
    timeout = setTimeout(() => {
      timeout = undefined;
      if (stopped) return;
      lastSent = Date.now();
      chain = chain.then(() => (stopped ? undefined : setFull(latest))).catch(() => {});
    }, wait);
  }

  async function flush() {
    if (stopped) return;
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    await chain;
    if (stopped) return;
    lastSent = Date.now();
    await setFull(latest);
  }

  function stop() {
    stopped = true;
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    latest = "";
  }

  return { push, flush, stop };
}

/** One output-shaping step applied during turn termination. */
export type TurnTerminationShapingStep = (body: string) => string;

/**
 * One-shot termination-shaping coordinator.
 *
 * Turns the final delivery body over through the supplied shaping steps
 * (banner splice, thinking composition, …) against ONE in-memory copy:
 * every step transforms that copy in place and only the very final result
 * is ever yielded, so there is no intermediate layout the surface could
 * render — no phase where every banner is smashed to the bottom before
 * being interleaved again. The whole pass is fail-open: any step that
 * throws, and any interruption, rejects the returned promise without ever
 * yielding anything, so the caller keeps the already-streamed output as
 * the delivered record instead of a partially shaped body.
 */
export async function renderTurnTerminationBody(
  body: string,
  steps: readonly TurnTerminationShapingStep[],
): Promise<string> {
  let working = body;
  for (const step of steps) {
    working = await step(working);
  }
  return working;
}
