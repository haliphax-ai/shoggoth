/**
 * Active turn surface registry for in-turn banners.
 *
 * Banners that belong to an in-flight turn — the session-send yield notice,
 * the "delivered in-turn" traces for exec / session-send notifications — must
 * land IN the turn's active output instead of being posted as separate
 * channel messages. The turn runner registers a per-session surface sink
 * while its turn is live; producers call `postTurnSurfaceNotice` and fall
 * back to `sendStatusMessage` only when no surface is registered (no live
 * turn output: OOB/internal turns, bare test harnesses).
 *
 * Mirrors the singleton-map pattern used by `sessions/steer-channel.ts`.
 */

/** Accepts one banner/notion line to fold into the in-flight turn output. */
export type ActiveTurnNoticeSink = (notice: string) => void;

const surfaces = new Map<string, ActiveTurnNoticeSink>();

/**
 * Register the active turn's surface sink for a session. The turn runner
 * calls this when the turn's output surface becomes live and unregisters in
 * its teardown path; a later turn's registration replaces an earlier one.
 */
export function registerActiveTurnSurface(
  sessionId: string,
  appendNotice: ActiveTurnNoticeSink,
): { unregister: () => void } {
  surfaces.set(sessionId, appendNotice);
  return {
    unregister: () => {
      if (surfaces.get(sessionId) === appendNotice) surfaces.delete(sessionId);
    },
  };
}

/**
 * Append a notice to the session's active turn output.
 * Returns false when no surface is registered (or the sink threw), so the
 * caller can fall back to posting a standalone status message.
 */
export function postTurnSurfaceNotice(sessionId: string, notice: string): boolean {
  const sink = surfaces.get(sessionId);
  if (!sink) return false;
  try {
    sink(notice);
    return true;
  } catch {
    return false;
  }
}

/** Visible for testing — clears all registered surfaces. */
export function _resetActiveTurnSurfaces(): void {
  surfaces.clear();
}
