/**
 * Parse a JSON error response body from an LLM API (Anthropic, Gemini, etc.)
 * and extract the human-readable error message.
 *
 * Both Anthropic and Gemini return errors in a similar shape:
 *   `{ error: { message: string, ... } }`
 *
 * Falls back to the first 500 characters of the raw text when parsing fails
 * or no `message` field is present.
 */
export function parseApiErrorBody(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    const msg = j.error?.message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  } catch {
    // ignore
  }
  return text.slice(0, 500);
}
