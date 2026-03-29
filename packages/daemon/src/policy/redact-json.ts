/**
 * Redaction hooks: replace values at dot-separated paths inside JSON-like trees.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const REDACTED = "[REDACTED]";

function setAtPath(root: unknown, segments: readonly string[]): void {
  if (segments.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    if (!isPlainObject(cur)) return;
    const next = cur[key];
    if (next === undefined) return;
    cur = next;
  }
  const leaf = segments[segments.length - 1]!;
  if (isPlainObject(cur) && leaf in cur) {
    cur[leaf] = REDACTED;
  }
}

/**
 * Parses `argsJson` when possible, applies path redaction, returns JSON string for `args_redacted_json`.
 */
export function redactToolArgsJson(
  argsJson: string,
  jsonPaths: readonly string[],
): string | undefined {
  if (jsonPaths.length === 0) {
    return argsJson;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson) as unknown;
  } catch {
    return JSON.stringify({ _redactionNote: "non_json_args", preview: argsJson.slice(0, 256) });
  }
  if (typeof parsed === "object" && parsed !== null) {
    const clone = JSON.parse(JSON.stringify(parsed)) as unknown;
    for (const p of jsonPaths) {
      const segs = p.split(".").filter(Boolean);
      if (segs.length) setAtPath(clone, segs);
    }
    return JSON.stringify(clone);
  }
  return JSON.stringify(parsed);
}

/**
 * Redact arbitrary JSON-serializable value (e.g. audit metadata objects).
 */
export function redactJsonValue(value: unknown, jsonPaths: readonly string[]): string {
  if (jsonPaths.length === 0) {
    return JSON.stringify(value);
  }
  const clone = JSON.parse(JSON.stringify(value)) as unknown;
  for (const p of jsonPaths) {
    const segs = p.split(".").filter(Boolean);
    if (segs.length) setAtPath(clone, segs);
  }
  return JSON.stringify(clone);
}
