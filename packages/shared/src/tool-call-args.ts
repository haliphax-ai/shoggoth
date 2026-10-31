import { sanitizeJsonEscapes } from "./sanitize-json-escapes";

/**
 * Normalize a tool call's raw arguments into a parseable JSON string.
 *
 * Provider-bound tool calls carry their arguments as a JSON *string*
 * (`function.arguments` in the OpenAI wire format, a JSON object in the
 * Anthropic / Gemini formats). A provider that cuts a response off at the
 * output-token limit leaves that string truncated mid-JSON — and every
 * provider adapter that parses it (Anthropic, Gemini) throws, while the
 * OpenAI-compatible adapter forwards the broken string verbatim and the
 * upstream rejects the whole request with an opaque 400.
 *
 * This helper is the single place that decides what a tool call's arguments
 * become when they cannot be parsed: escape-sanitize first (recovering
 * arguments that only contain an invalid escape sequence), and fall back to
 * an empty object when the arguments are genuinely incomplete.
 *
 * The daemon's tool loop and its model client MUST agree on the result, or
 * the transcript and the provider request diverge. Both call this.
 *
 * @param raw - The raw arguments as received from the provider. Non-string
 *   values (a provider that omitted `arguments` entirely) yield `"{}"`.
 * @returns A string that always parses as JSON.
 */
export function normalizeToolCallArgsJson(raw: unknown): string {
  if (typeof raw !== "string") return "{}";
  const fixed = sanitizeJsonEscapes(raw);
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    return "{}";
  }
}
