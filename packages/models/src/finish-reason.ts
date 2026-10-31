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
 * at the output-token limit.
 *
 * Used to tell two very different failures apart when a tool call's arguments
 * do not parse:
 *  - the model emitted malformed JSON on its own (healable — the model can
 *    retry with the same intent), versus
 *  - the provider cut the response off mid-arguments (NOT healable — the call
 *    can never succeed, and replaying it poisons the next request).
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
