// one-shot result delivery — post-teardown follow-up to the parent session:
// the spawn path delivers a one-shot's FIRST turn; the teardown calls
// `deliverOneShotFollowupResult` before terminating (kept out of the drain module).

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
 * turn (banner-less structured OOB delivery; no re-delivery envelope — the
 * child is still alive and terminated right after). Targets mirror the spawn
 * path: `respond_to` when recorded on the child row, else the spawning
 * session; an unusable target drops the delivery with a log. Resolves to the
 * delivered transcript text so the teardown can re-mark it (no double delivery).
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
