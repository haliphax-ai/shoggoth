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

/** Nudge message sent when the model's first OOB response was not valid structured JSON (subagent-result turns). */
export const OOB_NUDGE_WITH_SENDER =
  "\n\n⚠️ Your previous response was **not valid structured output**. You **MUST** respond with a JSON object containing `to_operator` (string or null) and `to_sender` (string or null). Respond with **only** the JSON object — no surrounding text.";

/** Nudge message sent when the model's first OOB response was not valid structured JSON (timer/cron turns). */
export const OOB_NUDGE_NO_SENDER =
  "\n\n⚠️ Your previous response was **not valid structured output**. You **MUST** respond with a JSON object containing `to_operator` (string or null). Respond with **only** the JSON object — no surrounding text.";
