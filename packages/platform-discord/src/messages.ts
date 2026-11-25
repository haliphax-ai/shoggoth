/**
 * User-facing strings for slash-command replies, gathered so wording changes
 * are single edits and duplicate copies cannot drift apart again. Dynamic
 * text is built by template functions; static text is a plain constant.
 * Delivery mechanics (response type, ephemeral flags, component clearing)
 * remain per call site — see docs/platform-discord.md ("Slash Commands").
 */
export const MESSAGES = {
  /** Session-resolution guard: no payload session and no channel binding. */
  unboundSessionWarning: "⚠️ No session bound to this channel. Provide a session_id.",

  /** The prompt takes more parameters than a Discord modal can carry. */
  promptTooManyParameters: (slug: string, count: number): string =>
    `⚠️ Prompt \`${slug}\` has ${count} parameters; Discord modals support at most 5.`,

  /** `session_model` assignment failed (op error or thrown). */
  failedSetModel: (reason: string): string => `⚠️ Failed to set model: ${reason}`,

  /** Prompt delivery failed (op error or thrown). */
  failedPrompt: (reason: string): string => `⚠️ Prompt failed: ${reason}`,

  /** `prompt_list` fetch failed (op error or thrown). */
  failedListPrompts: (reason: string): string => `⚠️ Failed to list prompts: ${reason}`,

  /** Cruise-control activation failed (op error or thrown). */
  failedActivateCruise: (reason: string): string =>
    `⚠️ Failed to activate cruise control: ${reason}`,

  /** Cruise-control deactivation failed (op error or thrown). */
  failedDeactivateCruise: (reason: string): string =>
    `⚠️ Failed to deactivate cruise control: ${reason}`,

  /** Successful cruise-control activation; escalation note and warning lines are optional. */
  cruiseActivated: (
    sessionId: string,
    escalate: string | undefined,
    warnings: readonly string[],
  ): string => {
    const warnSuffix = warnings.length ? `\n${warnings.map((w) => `⚠️ ${w}`).join("\n")}` : "";
    return `🚗 Cruise control activated for \`${sessionId}\`${escalate ? " (with escalation route)" : ""}.${warnSuffix}`;
  },

  /** A control op failed (op error or thrown); the op name interpolates in. */
  failedOp: (op: string, reason: string): string => `⚠️ \`${op}\` failed: ${reason}`,

  /** `session_steer` failed (op error or thrown). */
  failedSteer: (reason: string): string => `⚠️ Steer failed: ${reason}`,

  /** `session_kill` failed (op error or thrown). */
  failedClose: (reason: string): string => `⚠️ Close failed: ${reason}`,

  /** A `provider/model` reference failed validation. */
  invalidModelId: (modelId: string): string =>
    `⚠️ Invalid model format. Expected \`provider/model\`, got \`${modelId}\``,

  /** Title of the shared free-text "Enter Model" modal. */
  enterModelModalTitle: "Enter Model",
};
