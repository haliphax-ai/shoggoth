// ---------------------------------------------------------------------------
// ask-defer — posts builtin-ask choice prompts at turn end (like timer flushes)
// ---------------------------------------------------------------------------

import { validateChoiceArgs } from "@shoggoth/messaging";
import type { MessageToolCtx } from "../builtin-tool-registry";
import { getLogger } from "../../logging";

const log = getLogger("ask-defer");

interface PendingAsk {
  readonly sessionId: string;
  readonly args: Record<string, unknown>;
  readonly mtCtx: MessageToolCtx;
}

/**
 * Pending choice prompts per session — buffered while a turn is streaming so
 * the prompt never lands mid-output (potentially between split messages of
 * long output), then posted by {@link flushAsks} when the turn ends, mirroring
 * the timer scheduler's pending-timer flush.
 */
const pending = new Map<string, PendingAsk[]>();

/**
 * Register a choice prompt for deferred posting.
 *
 * When the session has a live turn, the prompt is buffered until that turn
 * ends and its result reports the queued state. Otherwise the post runs
 * immediately (no turn to wait for) and the live result is returned.
 */
export async function enqueueAsk(
  mtCtx: MessageToolCtx,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!turnQueueRunning(sessionId)) {
    return askNow(sessionId, args, mtCtx);
  }
  let buf = pending.get(sessionId);
  if (!buf) {
    buf = [];
    pending.set(sessionId, buf);
  }
  buf.push({ sessionId, args, mtCtx });
  log.debug("choice prompt deferred to turn end", { sessionId, count: buf.length });
  return {
    ok: true,
    deferred: true,
    choices: Array.isArray(args.choices) ? args.choices.length : 0,
    note: "prompt will be posted when the current turn ends",
  };
}

/**
 * Post every prompt queued during the turn that just ended. Called by the
 * turn queue's onTurnEnd hook — one buffer snapshot per turn, so prompts
 * queued by a later turn are never pulled forward into this flush.
 */
export async function flushAsks(sessionId: string): Promise<void> {
  const buf = pending.get(sessionId);
  if (!buf || buf.length === 0) return;
  pending.delete(sessionId);
  for (const ask of buf) {
    try {
      const result = await askNow(ask.sessionId, ask.args, ask.mtCtx);
      if (result.ok !== true) {
        log.warn("deferred choice prompt post failed", {
          sessionId: ask.sessionId,
          error: result.error,
        });
      } else {
        log.debug("deferred choice prompt posted", { sessionId: ask.sessionId });
      }
    } catch (e) {
      log.warn("deferred choice prompt post failed", {
        sessionId: ask.sessionId,
        err: String(e),
      });
    }
  }
}

/** Post a choice prompt now (validation first, so bad input fails fast). */
export function askNow(
  sessionId: string,
  args: Record<string, unknown>,
  mtCtx: MessageToolCtx,
): Promise<Record<string, unknown>> {
  const validated = validateChoiceArgs(args);
  if (!validated.ok) return Promise.resolve({ ok: false, error: validated.error });
  return mtCtx.execute(sessionId, { ...args, action: "choice" });
}

// ---------------------------------------------------------------------------
// module refs — injected by the daemon at bootstrap
// ---------------------------------------------------------------------------

let turnQueueRef: { current: { isRunning(sessionId: string): boolean } | undefined } = {
  current: undefined,
};

/** Set by the daemon at bootstrap with the turn queue singleton. */
export function setAskTurnQueue(queue: { isRunning(sessionId: string): boolean }): void {
  turnQueueRef.current = queue;
}

/** Test seam: clear module state between tests. */
export function resetAskDeferralForTests(): void {
  pending.clear();
  turnQueueRef.current = undefined;
}

function turnQueueRunning(sessionId: string): boolean {
  try {
    return turnQueueRef.current?.isRunning(sessionId) ?? false;
  } catch {
    return false;
  }
}
