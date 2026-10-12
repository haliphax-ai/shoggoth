/**
 * JSON Schema + guidance constants for structured out-of-band (OOB) deliveries.
 *
 * Subagent result turns respond with both `to_operator` and `to_sender` fields;
 * timer/cron fire turns respond with only `to_operator`.
 */

/** JSON Schema for a subagent-result OOB response (delivered to operator AND sender). */
export const OOB_SCHEMA_WITH_SENDER: Record<string, unknown> = {
  type: "object",
  properties: {
    to_operator: {
      type: ["string", "null"],
      description: "Message to deliver to the operator's channel. `null` = nothing to show.",
    },
    to_sender: {
      type: ["string", "null"],
      description:
        "Message to send back to the subagent/sender session. `null` = nothing to send back.",
    },
  },
  required: ["to_operator", "to_sender"],
  additionalProperties: false,
};

/** JSON Schema for a timer/cron OOB turn (delivered to operator only). */
export const OOB_SCHEMA_NO_SENDER: Record<string, unknown> = {
  type: "object",
  properties: {
    to_operator: {
      type: ["string", "null"],
      description: "Message to deliver to the operator's channel. `null` = nothing to show.",
    },
  },
  required: ["to_operator"],
  additionalProperties: false,
};

/** Guidance appended to subagent-result turns that must produce OOB structured output. */
export const OOB_WITH_SENDER_GUIDANCE =
  "\n\nThis is an out-of-band subagent response. Perform any actions in reaction to this message **BEFORE** you respond with structured output! Once you respond, your turn will end and you will not be able to act further, so act now!";

/** Guidance appended to timer-fire turns that must produce OOB structured output. */
export const OOB_NO_SENDER_GUIDANCE =
  "\n\nThis is an out-of-band message. You **MUST** perform any allowed actions necessary to follow its instructions **BEFORE** you respond with structured output! Once you respond, your turn will end and you will not be able to act further, so act now!";

/**
 * Nudge message sent when the model's first OOB response was not valid
 * structured JSON (subagent-result turns).
 *
 * The nudge turn is a **continuation** of the failed OOB turn: it replays the
 * same OOB system context and runs with the same tool set, which includes the
 * synthetic `__structured_output__` tool. The wording below tells the model
 * that explicitly so it can recover instead of replying with plain text again.
 */
export const OOB_NUDGE_WITH_SENDER =
  "\n\n⚠️ Your previous response was **not valid structured output**. This is a **continuation of the same out-of-band turn** — your tools are still available to you, including the synthetic `__structured_output__` tool. You **MUST** finish by calling `__structured_output__` with a JSON object containing `to_operator` (string or null) and `to_sender` (string or null). Do not answer with plain text — structured output is only captured from the `__structured_output__` tool call.";

/**
 * Nudge message sent when the model's first OOB response was not valid
 * structured JSON (timer/cron turns).
 *
 * See `OOB_NUDGE_WITH_SENDER` — same continuation semantics, but the
 * timer/cron schema only requires `to_operator`.
 */
export const OOB_NUDGE_NO_SENDER =
  "\n\n⚠️ Your previous response was **not valid structured output**. This is a **continuation of the same out-of-band turn** — your tools are still available to you, including the synthetic `__structured_output__` tool. You **MUST** finish by calling `__structured_output__` with a JSON object containing `to_operator` (string or null). Do not answer with plain text — structured output is only captured from the `__structured_output__` tool call.";

/** Warning surfaced when an OOB turn fails to produce structured output even after the nudge. */
export const OOB_FAILURE_WARNING =
  "⚠️ **Error**: An out-of-band message could not be processed. " +
  "The model did not respond with valid structured output after a follow-up attempt. " +
  "Please check the session logs for details.";

/**
 * Render the OOB failure warning together with the model's raw turn output.
 *
 * Total failures used to surface only the warning, discarding what the model
 * actually said. The raw output is prefixed with the warning so the operator
 * (or the session's bound channel) can still see — and act on — the model's
 * intended answer.
 */
export function formatOobFailureNotice(rawOutput?: string, maxChars = 4000): string {
  const trimmed = rawOutput?.trim() ?? "";
  if (!trimmed) return `${OOB_FAILURE_WARNING}\n\n_(the model produced no output)_`;
  const clipped = trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
  return `${OOB_FAILURE_WARNING}\n\n**Model output:**\n\`\`\`\n${clipped}\n\`\`\``;
}
