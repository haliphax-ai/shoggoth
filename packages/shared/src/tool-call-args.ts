import { sanitizeJsonEscapes } from "./sanitize-json-escapes";

/**
 * Normalize a tool call's raw arguments into a string that always parses as
 * JSON: escape-sanitize first, fall back to `"{}"` for non-string input or
 * genuinely incomplete arguments. The daemon tool loop and model client both
 * call this so the transcript and provider request agree. Background:
 * docs/shared.md — "Tool Call Args".
 *
 * @param raw - The raw arguments as received from the provider.
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
