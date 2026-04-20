import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseBoolField, parseMarkdownFrontmatter } from "./frontmatter";

export interface SkillRecord {
  readonly id: string;
  readonly title: string;
  readonly absolutePath: string;
  /** Effective enablement: frontmatter + config disabledIds. */
  readonly enabled: boolean;
  /** Optional freeform tags for search/filter (lowercase, alphanumeric with hyphens). */
  readonly tags: readonly string[];
  /** Optional broad grouping (e.g. "utilities", "dev-tools", "integrations"). */
  readonly category: string | null;
  /** Optional one-line description for search matching. */
  readonly description: string | null;
}

function walkMarkdownFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkMarkdownFiles(p, out);
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      out.push(p);
    }
  }
}

/**
 * Parses a YAML-ish inline array string like `[foo, bar, baz]` into a
 * lowercase string array.  Returns `[]` for missing or malformed input.
 */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  // Strip surrounding brackets if present: [a, b, c] → a, b, c
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function pathSlugId(root: string, filePath: string): string {
  const rel = relative(root, filePath).replace(/\\/g, "/");
  return rel.replace(/\.md$/i, "").replace(/\//g, ".");
}

/**
 * Recursively scans each root for `*.md` skills; parses YAML-like frontmatter.
 */
export function scanSkillDirectories(
  roots: readonly string[],
  disabledIds: ReadonlySet<string>,
): SkillRecord[] {
  const recordMap = new Map<string, SkillRecord>();

  for (const root of roots) {
    let st;
    try {
      st = statSync(root, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (!st?.isDirectory()) continue;

    const files: string[] = [];
    walkMarkdownFiles(root, files);
    files.sort((a, b) => a.localeCompare(b, "en"));

    for (const absolutePath of files) {
      const raw = readFileSync(absolutePath, "utf8");
      const { fields } = parseMarkdownFrontmatter(raw);
      const idRaw = fields["id"]?.trim();
      const id =
        idRaw && idRaw.length > 0
          ? idRaw
          : pathSlugId(root, absolutePath);
      const title =
        (fields["title"] ?? fields["name"] ?? "").trim() || id;
      const fileEnabled = parseBoolField(fields["enabled"], true);
      const configOk = !disabledIds.has(id);
      const tags = parseTags(fields["tags"]);
      const categoryRaw = fields["category"]?.trim().toLowerCase();
      const category = categoryRaw && categoryRaw.length > 0 ? categoryRaw : null;
      const descRaw = fields["description"]?.trim();
      const description = descRaw && descRaw.length > 0 ? descRaw : null;
      recordMap.set(id, {
        id,
        title,
        absolutePath,
        enabled: fileEnabled && configOk,
        tags,
        category,
        description,
      });
    }
  }

  return [...recordMap.values()];
}
