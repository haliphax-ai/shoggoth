/*
 * one-shot final result — the parent-facing delivery owed at teardown
 *
 * The spawn path delivers a one-shot's FIRST settled turn to its parent and
 * marks the delivered text here. Every later turn (a parent steer, an OOB
 * wake-up) leaves newer transcript text the parent would otherwise never
 * see: the notify-drain teardown calls `terminateOneShotWithFinalResult`
 * as its terminate closure, which dispatches the undelivered delta as a
 * structured OOB follow-up turn before the session terminates.
 *
 * Kept separate from `one-shot-notify-drain.ts` so the drain module's
 * hold/release machinery stays metric-identical to its historical shape and
 * the delivery stack (`control/ops-shared.ts`) never imports either.
 */

import type Database from "better-sqlite3";
import type { Logger } from "../logging";
import { beginOneShotDelivery, settleOneShotDelivery } from "./one-shot-wake-window";
import { deliverOneShotFollowupResult } from "./one-shot-result-delivery";
import { extractLatestTranscriptAssistantText } from "../sessions/transcript-to-chat";

/** Latest transcript text per one-shot the parent has already received. */
const lastDeliveredResultText = new Map<string, string>();

/**
 * Record the latest transcript text the spawn path already delivered to the
 * parent (the first settled turn's result). A later teardown delivers the
 * subagent's transcript only when its latest text differs — steering a
 * one-shot produces a newer reply, and that is the delta the parent must see
 * instead of silence.
 */
export function markOneShotResultDelivered(sessionId: string, assistantText: string): void {
  lastDeliveredResultText.set(sessionId.trim(), assistantText);
}

/** Clear every delivered-text mark (shutdown/tests). */
export function clearAllOneShotFinalResultMarks(): void {
  lastDeliveredResultText.clear();
}

/** A follow-up worth delivering: the undelivered final text and its target. */
interface OneShotFollowup {
  readonly text: string;
  readonly respondTo: string;
}

/**
 * Resolve the follow-up delivery a terminating one-shot owes its parent, if
 * any: the row must be live, have transcript text, and that text must differ
 * from what the spawn path already delivered (exact-equality dedupe — both
 * sides read the transcript, so only a turn that settled after the first
 * delivery can differ).
 */
function pendingFollowupFor(
  stateDb: Database.Database | undefined,
  sid: string,
  row:
    | {
        readonly status: string;
        readonly contextSegmentId: string;
        readonly subagentRespondTo: string | undefined;
        readonly parentSessionId: string | undefined;
      }
    | undefined,
): OneShotFollowup | undefined {
  if (!row || row.status === "terminated" || !stateDb) return undefined;
  const text = extractLatestTranscriptAssistantText(stateDb, sid, row.contextSegmentId);
  if (!text || text === lastDeliveredResultText.get(sid)) return undefined;
  return {
    text,
    respondTo: row.subagentRespondTo ?? row.parentSessionId ?? "",
  };
}

/**
 * The terminate closure for a one-shot's end-of-turn settle: deliver the
 * final transcript text as a structured OOB follow-up turn to its parent
 * when that text was not already delivered (the normal case for a steered
 * follow-up turn), then run the plain teardown either way.
 *
 * Every teardown path — the direct one, the deferred release, and the
 * safety timer — routes through here, so the parent always hears one of
 * "result" or (via the terminate notice) "ended" for the post-steer
 * lifetime of the child.
 */
export function terminateOneShotWithFinalResult(deps: {
  readonly sessionId: string;
  readonly stateDb?: Database.Database;
  readonly subLog: Logger;
  /** The row's fields the follow-up decision reads (status, segment, targets). */
  readonly row:
    | {
        readonly status: string;
        readonly contextSegmentId: string;
        readonly subagentRespondTo: string | undefined;
        readonly parentSessionId: string | undefined;
      }
    | undefined;
  /** The plain teardown every no-follow-up path shares. */
  readonly teardown: () => void;
  /** Lands a release a concurrent settle deferred behind this delivery. */
  readonly onSettled: () => void;
}): void {
  const sid = deps.sessionId.trim();
  const followup = pendingFollowupFor(deps.stateDb, sid, deps.row);
  // Missing row (legacy callers/tests) or already dead (TTL expiry / operator
  // kill owns the parent notification): tear down exactly as before.
  if (!followup) {
    lastDeliveredResultText.delete(sid);
    deps.teardown();
    return;
  }
  beginOneShotDelivery(sid);
  void (async () => {
    try {
      const deliveredText = await deliverOneShotFollowupResult({
        sessionId: sid,
        parentSessionId: followup.respondTo,
        text: followup.text,
      });
      // Record what this follow-up delivered so a concurrent settle that
      // lands mid-delivery cannot re-deliver the same text.
      lastDeliveredResultText.set(sid, deliveredText);
    } catch (e) {
      deps.subLog.warn("one-shot final result delivery failed", {
        sessionId: sid,
        err: String(e),
      });
    } finally {
      settleOneShotDelivery(sid);
      deps.onSettled();
      deps.teardown();
    }
  })();
}
