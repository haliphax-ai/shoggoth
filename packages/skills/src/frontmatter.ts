interface ParsedFrontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Minimal YAML-ish `key: value` lines between --- fences (v1).
 *
 * Keys accept any characters up to the first `:` (so keys may contain
 * spaces or other punctuation); quoted keys are not supported and a `:`
 * inside a key is not possible since it delimits the value.
 */
export function parseMarkdownFrontmatter(source: string): ParsedFrontmatter {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { fields: {}, body: source };
  }
  const fields: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") {
      i++;
      break;
    }
    // Linear-time split instead of a regex: `[^:]+\s*:\s*(.*)` matches a
    // non-colon prefix, optional spaces, the colon, and the value — but the
    // repeated `\s*` makes the engine backtrack quadratically on long
    // space runs (polynomial ReDoS on untrusted frontmatter lines).
    const colon = line.indexOf(":");
    if (colon > 0) {
      fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
    }
  }
  const body = lines.slice(i).join("\n").replace(/^\n+/, "");
  return { fields, body };
}

export function parseBoolField(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const v = raw.toLowerCase();
  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;
  return defaultValue;
}
