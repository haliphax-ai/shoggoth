/**
 * Platform-agnostic coalescing stream pusher.
 *
 * Batches rapid text updates so the downstream sink (message edit, etc.)
 * is called at most once per `minIntervalMs`.
 */

interface StreamCoordinatorConfig {
  minIntervalMs: number;
}

interface CoalescingStreamPusher {
  push(text: string): void;
  flush(): Promise<void>;
}

export function createCoalescingStreamPusher(
  setFull: (body: string) => Promise<void>,
  minIntervalMs: number,
): CoalescingStreamPusher {
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
