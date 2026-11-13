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
 * Keys accept any characters up to the first `:` (so keys may contain
 * spaces or other punctuation); quoted keys are not supported and a `:`
 * inside a key is not possible since it delimits the value.
 *
 * ## Malformed-line policy (skip, don't guess)
 *
 * Lines inside the fences that are blank or exactly a `---` fence are
 * structural and always tolerated. Any other line inside the fences that
 * does not parse as `key: value` — a line with no colon, or a line whose
 * colon is at index 0 (empty key) — makes the whole frontmatter block
 * malformed: `malformed` is set to true, and the invalid line is not
 * recorded as a field.
 *
 * Callers loading skills must treat a malformed frontmatter block as a
 * skip signal: the skill file is treated as if it did not exist, rather
 * than loaded with partially-parsed fields (see `scanSkillDirectories`
 * and `findSkillPathById`). A typo in frontmatter should never silently
 * produce a skill with missing metadata. Files that start with a `---`
 * fence but never close it are also malformed — the unclosed fence is
 * treated as a typo, not as a body.
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
    // Linear-time split instead of a regex: `[^:]+\s*:\s*(.*)` matches a
    // non-colon prefix, optional spaces, the colon, and the value — but the
    // repeated `\s*` makes the engine backtrack quadratically on long
    // space runs (polynomial ReDoS on untrusted frontmatter lines).
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
