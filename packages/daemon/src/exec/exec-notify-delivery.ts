// ---------------------------------------------------------------------------
// deliverExecNotifyMessage — background exec completion → OOB turn (issue #478)
// ---------------------------------------------------------------------------

import { truncateOutput, MAX_OUTPUT_DEFAULT } from "@shoggoth/os-exec";
import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { buildExecNotifyTurnBanner } from "../messaging/oob-turn-banner";
import { deliverOobStructuredResponse } from "../control/integration-ops";
import { OOB_NO_SENDER_GUIDANCE, OOB_SCHEMA_NO_SENDER } from "../messaging/oob-response-schemas";
import { truncateToolOutput } from "../sessions/builtin-handlers/truncate-output";
import type { SystemContext } from "@shoggoth/shared";
import { getLogger } from "../logging";
import type { ExecNotifyCompletion } from "./exec-notify-scheduler";

function truncateForNotify(
  raw: string,
  completion: ExecNotifyCompletion,
): { text: string; truncated: boolean } {
  const { options } = completion.handle;
  return truncateOutput(raw, options.maxOutput ?? MAX_OUTPUT_DEFAULT, options.truncation ?? "tail");
}

/**
 * The notification payload, shaped exactly like the result a blocking
 * (non-yielded) exec call would have returned: file-output options yield
 * paths instead of content, `splitStreams` splits, and inline output honors
 * `maxOutput`/`truncation`.
 */
export function buildExecNotifyResult(completion: ExecNotifyCompletion): Record<string, unknown> {
  const { handle } = completion;
  const result: Record<string, unknown> = {
    kind: "exec.notify",
    notifyId: handle.id,
    execSessionId: handle.execSessionId,
    pid: handle.pid,
    command: handle.command,
    exitCode: completion.exitCode,
    signal: completion.signal,
  };
  if (completion.lost) {
    result.lost = true;
    result.note = "daemon restarted before the process was observed finishing; exit code unknown";
    return result;
  }

  const { options } = handle;
  if (options.outputFile) {
    result.outputFile = options.outputFile;
    return result;
  }
  if (options.stdoutFile || options.stderrFile) {
    if (options.stdoutFile) {
      result.stdoutFile = options.stdoutFile;
    } else {
      const t = truncateForNotify(completion.stdout ?? "", completion);
      result.stdout = t.text;
      if (t.truncated) result.stdoutTruncated = true;
    }
    if (options.stderrFile) {
      result.stderrFile = options.stderrFile;
    } else {
      const t = truncateForNotify(completion.stderr ?? "", completion);
      result.stderr = t.text;
      if (t.truncated) result.stderrTruncated = true;
    }
    return result;
  }
  if (options.splitStreams) {
    const outT = truncateForNotify(completion.stdout ?? "", completion);
    const errT = truncateForNotify(completion.stderr ?? "", completion);
    result.stdout = outT.text;
    result.stderr = errT.text;
    if (outT.truncated) result.stdoutTruncated = true;
    if (errT.truncated) result.stderrTruncated = true;
    return result;
  }
  const combined = truncateForNotify(
    (completion.stdout ?? "") + (completion.stderr ?? ""),
    completion,
  );
  result.output = combined.text;
  if (combined.truncated) result.truncated = true;
  return result;
}

/** Deliver a completed background exec through the same OOB boundary as timers. */
export async function deliverExecNotifyMessage(completion: ExecNotifyCompletion): Promise<void> {
  const { handle } = completion;
  const ext = subagentRuntimeExtensionRef.current;
  if (!ext) {
    getLogger("exec-notify").warn("exec notify delivery skipped: subagent runtime not available", {
      sessionId: handle.sessionId,
    });
    return;
  }
  // OOB system context for the notify turn. Replayed by the nudge turn inside
  // deliverOobStructuredResponse so a format-failure nudge reads as a
  // continuation of this same OOB turn rather than an unrelated prompt.
  const oobSystemContext: SystemContext = {
    kind: "exec.notify",
    summary: "This turn was triggered by a background builtin-exec completing.",
    guidance: OOB_NO_SENDER_GUIDANCE,
  };
  // Surface the completion as an OOB banner (↩️): post a "processing" banner,
  // stream the status bar into it while the turn runs, then append the
  // terminal banner + to_operator content on completion. Falls back gracefully
  // to plain (no-banner) delivery when the session is not message-surface
  // bound or the platform lacks the capability.
  const bannerText = buildExecNotifyTurnBanner({
    handleId: handle.id,
    command: handle.command,
  });
  const bannerHandle = await ext.oobTurnBanner?.begin({
    sessionId: handle.sessionId,
    processing: bannerText.processing,
  });
  const payload = buildExecNotifyResult(completion);
  const userContent = truncateToolOutput(
    `Background builtin-exec completed (notify handle \`${handle.id}\`):\n` +
      JSON.stringify(payload, null, 2),
  );
  const turn = await ext.runSessionModelTurn({
    sessionId: handle.sessionId,
    userContent,
    userMetadata: { exec_notify: true },
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
      subLog: getLogger("exec-notify"),
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
