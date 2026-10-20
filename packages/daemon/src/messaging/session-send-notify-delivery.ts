// ---------------------------------------------------------------------------
// deliverSessionSendNotifyMessage — yielded session-send reply → in-turn steer
// or OOB turn
// ---------------------------------------------------------------------------
//
// Delivery twin of `deliverExecNotifyMessage`: when a yielded
// `builtin-session-send` handle's target turn finally settles, the reply is
// delivered to the *calling* session — in-turn through the steer channel when
// a turn is active, as an OOB turn otherwise (guaranteed via the fallback).

import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { buildInTurnEventBanner, deliverInTurnEvent } from "./in-turn-event";
import { postTurnSurfaceNotice } from "../presentation/active-turn-surface";
import { buildSessionSendReplyTurnBanner } from "./oob-turn-banner";
import { deliverOobStructuredResponse } from "../control/integration-ops";
import { OOB_NO_SENDER_GUIDANCE, OOB_SCHEMA_NO_SENDER } from "./oob-response-schemas";
import { truncateToolOutput } from "../sessions/builtin-handlers/truncate-output";
import type { SystemContext } from "@shoggoth/shared";
import { getLogger } from "../logging";
import type { SessionSendNotifyCompletion } from "../sessions/session-send-notify-scheduler";

/**
 * The notification payload, shaped like the result a blocking (non-yielded)
 * session-send call would have returned, plus the notify correlation fields.
 */
export function buildSessionSendNotifyResult(
  completion: SessionSendNotifyCompletion,
): Record<string, unknown> {
  const { handle } = completion;
  const result: Record<string, unknown> = {
    kind: "session.sendReply",
    notifyId: handle.id,
    targetSessionId: handle.targetSessionId,
    message: handle.message,
  };
  if (completion.failed) {
    result.failed = true;
    result.error = completion.error ?? "session_send failed";
    return result;
  }
  result.reply = completion.reply ?? null;
  if (completion.failover !== undefined) result.failover = completion.failover;
  return result;
}

/**
 * Deliver a settled session-send reply: in-turn via the steer channel when the
 * calling session has an active turn, OOB otherwise.
 */
export async function deliverSessionSendNotifyMessage(
  completion: SessionSendNotifyCompletion,
): Promise<void> {
  const { handle } = completion;
  const payload = buildSessionSendNotifyResult(completion);
  const outcomeLabel = completion.failed ? "failed" : "received";
  const body = truncateToolOutput(
    `Delayed session-send reply ${outcomeLabel} (notify handle \`${handle.id}\`):\n` +
      JSON.stringify(payload, null, 2),
  );
  // --- In-turn path: inject into the active turn's steer channel when one
  // exists. Falls back to the OOB turn below when no turn is active, or when
  // the turn ends before the queued event is drained (guaranteed delivery via
  // the steer channel's drop callback).
  const banner = buildInTurnEventBanner({
    emoji: "📨",
    title: "Session-send reply",
    detail: handle.targetSessionId,
    id: handle.id,
  });
  const outcome = await deliverInTurnEvent({
    sessionId: handle.sessionId,
    content: `${banner}\n\n${body}`,
    fallback: () => deliverSessionSendOobTurn(completion),
  });
  // Surface trace for in-turn delivery (best-effort): folded into the
  // active turn's own output when one is live, posted as a standalone
  // message only when no turn surface exists. The OOB fallback
  // posts its own processing/terminal banners, so it needs no extra post.
  if (outcome === "in_turn") {
    const deliveryBanner = `> 📨 ✅ Session-send reply delivered in-turn: *${handle.targetSessionId}* \`${handle.id}\``;
    if (!postTurnSurfaceNotice(handle.sessionId, deliveryBanner)) {
      const ext = subagentRuntimeExtensionRef.current;
      await ext?.sendStatusMessage?.(handle.sessionId, deliveryBanner).catch((e) => {
        getLogger("session-send-notify").warn("session-send delivery banner failed", {
          sessionId: handle.sessionId,
          err: String(e),
        });
      });
    }
  }
  getLogger("session-send-notify").debug("session-send notify delivery resolved", {
    id: handle.id,
    sessionId: handle.sessionId,
    outcome,
  });
}

/** OOB delivery path: full structured turn on the calling session. */
async function deliverSessionSendOobTurn(completion: SessionSendNotifyCompletion): Promise<void> {
  const { handle } = completion;
  const ext = subagentRuntimeExtensionRef.current;
  if (!ext) {
    getLogger("session-send-notify").warn(
      "session-send notify delivery skipped: subagent runtime not available",
      { sessionId: handle.sessionId },
    );
    return;
  }
  // OOB system context for the notify turn. Replayed by the nudge turn inside
  // deliverOobStructuredResponse so a format-failure nudge reads as a
  // continuation of this same OOB turn rather than an unrelated prompt.
  const oobSystemContext: SystemContext = {
    kind: "session.sendReply",
    summary: "This turn was triggered by a delayed session-send reply arriving.",
    guidance: OOB_NO_SENDER_GUIDANCE,
  };
  // Surface the reply as an OOB banner (📨): post a "processing" banner,
  // stream the status bar into it while the turn runs, then append the
  // terminal banner + to_operator content on completion. Falls back gracefully
  // to plain (no-banner) delivery when the session is not message-surface
  // bound or the platform lacks the capability.
  const bannerText = buildSessionSendReplyTurnBanner({
    handleId: handle.id,
    targetSessionId: handle.targetSessionId,
  });
  const bannerHandle = await ext.oobTurnBanner?.begin({
    sessionId: handle.sessionId,
    processing: bannerText.processing,
  });
  const payload = buildSessionSendNotifyResult(completion);
  const outcomeLabel = completion.failed ? "failed" : "received";
  const userContent = truncateToolOutput(
    `Delayed session-send reply ${outcomeLabel} (notify handle \`${handle.id}\`):\n` +
      JSON.stringify(payload, null, 2),
  );
  const turn = await ext.runSessionModelTurn({
    sessionId: handle.sessionId,
    userContent,
    userMetadata: { session_send_notify: true },
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
      respondTo: handle.sessionId,
      ext,
      subLog: getLogger("session-send-notify"),
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
