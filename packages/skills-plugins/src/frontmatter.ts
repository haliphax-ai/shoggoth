interface ParsedFrontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Minimal YAML-ish `key: value` lines between --- fences (v1). */
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
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (m) {
      fields[m[1]!] = m[2]!.trim();
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
