/*
 * one-shot result delivery — post-teardown follow-up to the parent session
 *
 * A one-shot subagent's result is delivered by the spawn path when its FIRST
 * turn settles. Any later turn (a parent steer, an OOB wake-up turn) produces
 * output the parent would otherwise never see: the teardown terminates the
 * session silently. The teardown calls `deliverOneShotFollowupResult` right
 * before terminating so the parent's final turn text reaches its
 * `respond_to` session as a structured OOB delivery — the same surface a
 * normal result uses.
 *
 * Kept separate from `one-shot-notify-drain.ts` (its only caller) so the
 * delivery stack (`control/ops-shared.ts`) never has to import the teardown
 * module — and vice versa.
 */

import type { SystemContext } from "@shoggoth/shared";
import { subagentRuntimeExtensionRef } from "./subagent-extension-ref";
import { OOB_NO_SENDER_GUIDANCE, OOB_SCHEMA_NO_SENDER } from "../messaging/oob-response-schemas";
import { assertDeliveryTargetNotTerminated } from "../control/ops-shared";
import { oneShotWakeFallback } from "./one-shot-wake-window";
import { getLogger } from "../logging";

const log = getLogger("one-shot-result");

const OOB_MAX_CHARS = 8000;

/**
 * Deliver a one-shot's post-first-turn output to its parent as an out-of-band
 * turn. Mirrors `runSubagentResultOobTurn` in shape (banner-less structured
 * OOB delivery; the parent re-routes through `to_operator`/`to_sender`), but
 * without the result wrapper: the child session is still alive at dispatch
 * time and is terminated right after, so the parent needs the transcript text
 * plus the completion tag, not a re-delivery envelope.
 *
 * Delivery targets mirror the spawn path: `respond_to` when one was recorded
 * on the child row, else the spawning session. A target that cannot run a
 * turn (missing or terminated) drops the delivery with a log — the child
 * still terminates, and the caller never retries.
 *
 * Resolves to the transcript text that was delivered (the same string the
 * caller passed); the teardown re-marks it so a concurrent settle landing
 * mid-delivery cannot deliver it a second time.
 */
export async function deliverOneShotFollowupResult(input: {
  /** The one-shot child session id (for logs and the completion tag). */
  readonly sessionId: string;
  /** Parent session to deliver to (child's `respond_to` or parent lineage). */
  readonly parentSessionId: string;
  /** The child's latest transcript text (the post-steer reply). */
  readonly text: string;
}): Promise<string> {
  const ext = subagentRuntimeExtensionRef.current;
  const respondTo = input.parentSessionId.trim();
  if (!ext || !respondTo) {
    log.warn("one-shot follow-up delivery skipped: no runtime or respond_to target", {
      sessionId: input.sessionId,
      respondTo: respondTo || undefined,
    });
    return input.text;
  }
  const truncated =
    input.text.length > OOB_MAX_CHARS ? input.text.slice(0, OOB_MAX_CHARS) : input.text;
  const content = `[Subagent completed] session_id: \`${input.sessionId}\`\n\n${truncated}`;
  const systemContext: SystemContext = {
    kind: "subagent.result",
    summary: `Follow-up result delivered from one-shot subagent ${input.sessionId}.`,
    data: {
      child_session_id: input.sessionId,
      mode: "one_shot",
      followup: true,
    },
    guidance: OOB_NO_SENDER_GUIDANCE,
  };
  return oneShotWakeFallback(respondTo, async (): Promise<string> => {
    if (!(await assertDeliveryTargetNotTerminated(respondTo, log))) return input.text;
    const turn = await ext.runSessionModelTurn({
      sessionId: respondTo,
      userContent: content,
      userMetadata: {
        subagent_result: true,
        child_session_id: input.sessionId,
        one_shot_followup: true,
      },
      systemContext,
      delivery: { kind: "internal" },
      modelInvocationOverride: {
        responseSchema: { schema: OOB_SCHEMA_NO_SENDER },
        structuredOutputMode: "best-effort",
      },
    });
    if (turn?.aborted || !turn?.latestAssistantText) return input.text;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(turn.latestAssistantText) as Record<string, unknown>;
    } catch {
      log.warn("one-shot follow-up OOB response was not structured output", {
        sessionId: input.sessionId,
        respondTo,
      });
      return input.text;
    }
    const toOperator = parsed?.to_operator;
    if (typeof toOperator === "string" && toOperator.length > 0) {
      const clipped =
        toOperator.length > OOB_MAX_CHARS ? toOperator.slice(0, OOB_MAX_CHARS) : toOperator;
      await ext.postToOperator?.({ sessionId: respondTo, userContent: clipped });
    }
    return input.text;
  });
}
