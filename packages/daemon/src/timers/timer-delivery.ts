import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import type { TimerEntry } from "./timer-heap";
import { buildTimerTurnBanner } from "../messaging/oob-turn-banner";
import { deliverOobStructuredResponse } from "../control/integration-ops";
import { OOB_NO_SENDER_GUIDANCE, OOB_SCHEMA_NO_SENDER } from "../messaging/oob-response-schemas";
import type { SystemContext } from "@shoggoth/shared";
import { getLogger } from "../logging";

/** Deliver a timer through the same cancellation-aware OOB boundary as subagent results. */
export async function deliverTimerMessage(entry: TimerEntry): Promise<void> {
  const { id: timerId, sessionId, message } = entry;
  const ext = subagentRuntimeExtensionRef.current;
  if (!ext) {
    getLogger("timer-scheduler").warn("timer delivery skipped: subagent runtime not available", {
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
      subLog: getLogger("timer"),
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
