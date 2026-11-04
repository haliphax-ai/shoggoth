/** Max characters before truncation kicks in. */
const MAX_CHARS = 50_000;
/** Characters kept from each end when truncating. */
const KEEP = 10_000;

const NOTICE = "\n\n[... truncated — output exceeded 50,000 characters ...]\n\n";

/**
 * If `text` exceeds 50k characters, return the first and last 10k with a
 * truncation notice in between. Otherwise return as-is.
 */
export function truncateToolOutput(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, KEEP) + NOTICE + text.slice(-KEEP);
}

/** Max JSON payload size for a tool result before truncation. */
const MAX_RESULT_JSON_CHARS = 50_000;

/** Head kept when a result can only be stubbed (unparseable or still too large). */
const STUB_KEEP_HEAD = 40_000;

const STUB_NOTICE = "\n\n[... truncated — tool result exceeded 50,000 characters ...]";

/** Strings longer than this (after truncation) are clipped per-field. */
const PER_STRING_KEEP = 4_000;

const PER_STRING_NOTICE = " [... truncated ...]";

/**
 * Safeguard for a tool result's JSON payload, applied at the registry
 * boundary so every builtin tool is capped. Handlers that already truncate
 * their own large string fields (exec, fetch, fs read, logs) are unaffected —
 * their payloads stay under the limit and pass through byte-for-byte.
 * Oversized payloads from tools without an internal cap are kept parseable:
 * string leafs are clipped in place, and if the payload is still too large
 * (or not JSON at all), the head is kept with an explicit truncation notice.
 */
export function truncateResultJson(raw: string): string {
  if (raw.length <= MAX_RESULT_JSON_CHARS) return raw;

  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    // Plain (non-JSON) result text — keep both ends like a normal output
    // truncation so the model still sees the payload shape.
    return truncateToolOutput(raw);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.slice(0, STUB_KEEP_HEAD) + STUB_NOTICE;
  }

  const reserialized = JSON.stringify(walkJsonStrings(parsed));
  if (reserialized.length <= MAX_RESULT_JSON_CHARS) return reserialized;

  // Even the per-string floor did not get us under the cap (pathologically
  // many fields) — fall back to a compact stub preserving the JSON head.
  return raw.slice(0, STUB_KEEP_HEAD) + STUB_NOTICE;
}

/**
 * Walk a parsed JSON value and clip oversized string leafs in place. Object
 * shapes, array lengths, and ordering are preserved; only long strings are
 * shortened, so the truncated payload still parses and keeps its structure.
 */
function walkJsonStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= PER_STRING_KEEP) return value;
    return value.slice(0, PER_STRING_KEEP) + PER_STRING_NOTICE;
  }
  if (Array.isArray(value)) {
    return value.map(walkJsonStrings);
  }
  if (value !== null && typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = walkJsonStrings(v);
    }
    return obj;
  }
  return value;
}
