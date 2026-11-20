/*
 * one-shot wake window — delivery markers for held one-shot sessions
 *
 * A held one-shot (one waiting for its pending exec-notify handles to drain)
 * must not be torn down while a wake-up delivery is still running. Delivery
 * paths mark the window with `beginOneShotDelivery` / `settleOneShotDelivery`
 * and `oneShotWakeFallback` wraps a delivery body in the same marker.
 *
 * This is a leaf module on purpose: both the notify-drain teardown (which
 * consults the window) and the delivery stack in `control/ops-shared.ts`
 * (which opens it) import it. Routing the marker through the drain module
 * would tie ops-shared back into the teardown module it must stay independent
 * of.
 */

const deliveryInFlight = new Set<string>();

/** Begin a wake-up window: drained releases defer until settleOneShotDelivery. */
export function beginOneShotDelivery(sessionId: string): void {
  deliveryInFlight.add(sessionId.trim());
}

/** Settle the wake-up window; a deferred release lands when the queue idles. */
export function settleOneShotDelivery(sessionId: string): void {
  deliveryInFlight.delete(sessionId.trim());
}

/** Whether a wake-up delivery is currently in flight for the session. */
export function isOneShotDeliveryInFlight(sessionId: string): boolean {
  return deliveryInFlight.has(sessionId.trim());
}

/**
 * Wrap an OOB fallback delivery: the steer drop callback fires between turns
 * (queue momentarily idle), so the marker must cover the fallback turn too.
 */
export async function oneShotWakeFallback<T>(
  sessionId: string,
  inner: () => Promise<T>,
): Promise<T> {
  const sid = sessionId.trim();
  beginOneShotDelivery(sid);
  try {
    return await inner();
  } finally {
    settleOneShotDelivery(sid);
  }
}

/** Clear every open wake-window marker (shutdown/tests). */
export function clearAllOneShotDeliveryWindows(): void {
  deliveryInFlight.clear();
}
