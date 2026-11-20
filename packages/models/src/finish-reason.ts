/**
 * Provider-reported stop reasons, normalized.
 *
 * Providers spell the "output budget exhausted" stop reason differently:
 * OpenAI-compatible APIs report `finish_reason: "length"`, Anthropic reports
 * `stop_reason: "max_tokens"`, and Gemini reports `finishReason: "MAX_TOKENS"`.
 * All of them mean the same thing for the daemon: generation stopped
 * mid-stream because the output-token limit was reached, so a tool call's
 * arguments may have been cut off mid-JSON.
 */

/**
 * Whether a provider-reported finish reason means the response was truncated
 * at the output-token limit. Used to distinguish healable malformed-JSON
 * failures from non-healable provider truncation when a tool call's arguments
 * fail to parse (see docs/models.md, "Truncation and Finish Reasons").
 *
 * @param finishReason - Provider-reported stop reason, if any.
 */
export function isTruncationFinishReason(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  switch (finishReason.trim().toLowerCase()) {
    case "length":
    case "max_tokens":
    case "max_output_tokens":
    case "maxoutputtokens":
      return true;
    default:
      return false;
  }
}
