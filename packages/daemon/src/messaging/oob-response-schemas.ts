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
export const OOB_WITH_SENDER_GUIDANCE = `This is an out-of-band subagent response. Perform any actions in reaction to this message **BEFORE** you respond with structured output.`;

/** Guidance appended to timer-fire turns that must produce OOB structured output. */
export const OOB_NO_SENDER_GUIDANCE = `This is an out-of-band message. Perform any actions requested in this message **BEFORE** you respond with structured output!`;
