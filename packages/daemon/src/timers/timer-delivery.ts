import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { deliverOobStructuredResponse } from "../control/integration-ops";
import { OOB_NO_SENDER_GUIDANCE, OOB_SCHEMA_NO_SENDER } from "../messaging/oob-response-schemas";
import { getLogger } from "../logging";

/** Deliver a timer through the same cancellation-aware OOB boundary as subagent results. */
export async function deliverTimerMessage(sessionId: string, message: string): Promise<void> {
  const ext = subagentRuntimeExtensionRef.current;
  if (!ext) {
    getLogger("timer-scheduler").warn("timer delivery skipped: subagent runtime not available", {
      sessionId,
    });
    return;
  }
  const turn = await ext.runSessionModelTurn({
    sessionId,
    userContent: message,
    userMetadata: { timer_fire: true },
    delivery: { kind: "internal" },
    systemContext: {
      kind: "timer.fire",
      summary: "This turn was triggered by a deferred timer.",
      guidance: OOB_NO_SENDER_GUIDANCE,
    },
    modelInvocationOverride: {
      responseSchema: { schema: OOB_SCHEMA_NO_SENDER },
      structuredOutputMode: "best-effort",
    },
  });
  if (turn?.aborted || turn?.latestAssistantText) {
    await deliverOobStructuredResponse({
      structuredResponse: turn.latestAssistantText,
      aborted: turn.aborted,
      respondTo: sessionId,
      ext,
      subLog: getLogger("timer"),
      hasSender: false,
    });
  }
}
