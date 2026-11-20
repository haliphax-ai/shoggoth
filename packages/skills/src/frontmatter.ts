interface ParsedFrontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
  /**
   * True when the frontmatter block is malformed under the skip policy (see
   * {@link parseMarkdownFrontmatter}): skill loaders must treat such files
   * as absent rather than loading them with partial fields.
   */
  readonly malformed: boolean;
}

/**
 * Minimal YAML-ish `key: value` lines between --- fences (v1).
 *
 * Any non-parseable line makes the whole block malformed, and callers treat
 * malformed blocks as a skip signal (the file is treated as absent). Full
 * policy: docs/skills.md — "Malformed Frontmatter (Skip Policy)".
 */
export function parseMarkdownFrontmatter(source: string): ParsedFrontmatter {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { fields: {}, body: source, malformed: false };
  }
  const fields: Record<string, string> = {};
  let malformed = false;
  let closed = false;
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") {
      closed = true;
      i++;
      break;
    }
    if (line.trim().length === 0) {
      continue;
    }
    // Linear-time split instead of a regex: `[^:]+\s*:\s*(.*)` backtracks
    // quadratically on long space runs (ReDoS on untrusted frontmatter lines).
    const colon = line.indexOf(":");
    if (colon <= 0) {
      // No colon at all, or an empty key (`: value`): malformed line, which
      // invalidates the whole frontmatter block under the skip policy.
      malformed = true;
      continue;
    }
    fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  if (closed) {
    const body = lines.slice(i).join("\n").replace(/^\n+/, "");
    return { fields, body, malformed };
  }
  // The opening fence was never closed: treat the whole block as malformed.
  return { fields, body: "", malformed: true };
}

export function parseBoolField(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const v = raw.toLowerCase();
  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;
  return defaultValue;
}
