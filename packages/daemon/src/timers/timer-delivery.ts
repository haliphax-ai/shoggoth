import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import type { TimerEntry } from "./timer-heap";
import { buildTimerTurnBanner } from "../messaging/oob-turn-banner";
import { boundSessionStore, deliverOobStructuredResponse } from "../control/ops-shared";
import { OOB_NO_SENDER_GUIDANCE, OOB_SCHEMA_NO_SENDER } from "../messaging/oob-response-schemas";
import type { SystemContext } from "@shoggoth/shared";
import { getLogger } from "../logging";

const log = getLogger("timer");

/**
 * Resolve the session a timer fires onto. A timer owned by a terminated
 * session whose `session_anchor` is still alive retargets to the anchor:
 * otherwise the platform's turn guard rejects the dead owner, the timer is
 * already marked fired, and the anchored session silently never receives the
 * wake-up (a one-shot subagent scheduling a parent-anchored check-in loses it
 * the moment its own teardown terminates the owner row).
 *
 * Returns the owner unchanged when it is alive, when no store is bound
 * (tests/embeds — fail-open), or when the anchor is missing or itself
 * terminated (nothing live to deliver to).
 */
export function resolveTimerDeliveryTarget(
  entry: Pick<TimerEntry, "sessionId" | "sessionAnchor">,
): string {
  const owner = entry.sessionId;
  const anchor = entry.sessionAnchor?.trim();
  if (!anchor || anchor === owner) return owner;
  const store = boundSessionStore;
  if (!store) return owner;
  const ownerRow = store.getById(owner);
  if (!ownerRow || ownerRow.status !== "terminated") return owner;
  const anchorRow = store.getById(anchor);
  if (!anchorRow || anchorRow.status === "terminated") return owner;
  log.warn("timer retargeted: owner terminated, delivering to its anchor session", {
    timerOwner: owner,
    anchor,
  });
  return anchor;
}

/** Deliver a timer through the same cancellation-aware OOB boundary as subagent results. */
export async function deliverTimerMessage(entry: TimerEntry): Promise<void> {
  const { id: timerId, message } = entry;
  const sessionId = resolveTimerDeliveryTarget(entry);
  const ext = subagentRuntimeExtensionRef.current;
  if (!ext) {
    log.warn("timer delivery skipped: subagent runtime not available", {
      sessionId,
    });
    return;
  }
  // OOB system context for the timer turn. Replayed by the nudge turn inside
  // deliverOobStructuredResponse so a format-failure nudge reads as a
  // continuation of this same OOB turn rather than an unrelated prompt.
  const oobSystemContext: SystemContext = {
    kind: "timer.fire",
    summary: "This turn was triggered by a deferred timer.",
    guidance: OOB_NO_SENDER_GUIDANCE,
  };
  // Surface the timer as an OOB banner (issue #363): post a "processing"
  // banner, stream the status bar into it while the turn runs, then append the
  // terminal banner + to_operator content on completion. Falls back gracefully
  // to plain (no-banner) delivery when the session is not message-surface
  // bound or the platform lacks the capability.
  const bannerText = buildTimerTurnBanner({ timerId, message });
  const bannerHandle = await ext.oobTurnBanner?.begin({
    sessionId,
    processing: bannerText.processing,
  });
  const turn = await ext.runSessionModelTurn({
    sessionId,
    userContent: message,
    userMetadata: { timer_fire: true },
    delivery: { kind: "internal" },
    systemContext: oobSystemContext,
    modelInvocationOverride: {
      responseSchema: { schema: OOB_SCHEMA_NO_SENDER },
      structuredOutputMode: "best-effort",
    },
    ...(bannerHandle ? { statusBarSink: bannerHandle } : {}),
  });
  if (turn?.aborted || turn?.latestAssistantText) {
    await deliverOobStructuredResponse({
      structuredResponse: turn.latestAssistantText,
      aborted: turn.aborted,
      respondTo: sessionId,
      ext,
      subLog: log,
      hasSender: false,
      systemContext: oobSystemContext,
      ...(bannerHandle
        ? {
            banner: {
              handle: bannerHandle,
              terminal: bannerText.terminal,
              ...(turn.statusBarLine ? { statusBar: turn.statusBarLine } : {}),
            },
          }
        : {}),
    });
  }
}
