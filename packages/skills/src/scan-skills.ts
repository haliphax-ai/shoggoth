import { readFile, readdir, stat } from "node:fs/promises";
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

async function walkMarkdownFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkMarkdownFiles(p, out);
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      out.push(p);
    }
  }
}

/** Matches a conforming tag: lowercase letters, digits, hyphens. */
const TAG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Parses a YAML-ish inline array string like `[foo, bar, baz]` into a
 * lowercase string array.  Returns `[]` for missing or malformed input.
 *
 * Tags are normalized (trimmed, lowercased) and then validated against
 * `TAG_PATTERN`.  Non-conforming tags are **dropped** rather than kept or
 * rejected: tags are advisory metadata parsed from untrusted frontmatter,
 * so a malformed tag should never fail a skill scan, and keeping it would
 * leak characters that search (exact-match tag filters, substring scoring)
 * never matches.  A tag that trims to empty is also dropped.
 */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  // Strip surrounding brackets if present: [a, b, c] → a, b, c
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && TAG_PATTERN.test(t));
}

function pathSlugId(root: string, filePath: string): string {
  const rel = relative(root, filePath).replace(/\\/g, "/");
  return rel.replace(/\.md$/i, "").replace(/\//g, ".");
}

/**
 * Recursively scans each root for `*.md` skills; parses YAML-like frontmatter.
 *
 * A file whose frontmatter block is malformed under the skip policy (see
 * `parseMarkdownFrontmatter`) is treated as if it did not exist: it produces
 * no `SkillRecord`, so it cannot shadow other skills or be shadowed, and it
 * never surfaces partial metadata from a typo'd frontmatter block.
 */
export async function scanSkillDirectories(
  roots: readonly string[],
  disabledIds: ReadonlySet<string>,
): Promise<SkillRecord[]> {
  const recordMap = new Map<string, SkillRecord>();

  for (const root of roots) {
    let st;
    try {
      st = await stat(root);
    } catch {
      continue;
    }
    if (!st?.isDirectory()) continue;

    const files: string[] = [];
    await walkMarkdownFiles(root, files);
    files.sort((a, b) => a.localeCompare(b, "en"));

    for (const absolutePath of files) {
      const raw = await readFile(absolutePath, "utf8");
      const { fields, malformed } = parseMarkdownFrontmatter(raw);
      if (malformed) {
        // Skip policy: a malformed frontmatter block means the file cannot
        // be trusted as a skill — skip it entirely.
        continue;
      }
      const idRaw = fields["id"]?.trim();
      const id = idRaw && idRaw.length > 0 ? idRaw : pathSlugId(root, absolutePath);
      const title = (fields["title"] ?? fields["name"] ?? "").trim() || id;
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

/**
 * Finds the absolute path of the skill with the given id, scanning roots in
 * reverse so later roots win (matching `scanSkillDirectories` last-wins
 * behavior).  Skips non-matching files without building `SkillRecord`s, and
 * stops as soon as a match is found.  Files with malformed frontmatter are
 * skipped exactly like in `scanSkillDirectories`: a path lookup must not
 * resolve to a skill whose frontmatter does not parse.
 */
export async function findSkillPathById(
  roots: readonly string[],
  id: string,
): Promise<string | undefined> {
  for (let i = roots.length - 1; i >= 0; i--) {
    const root = roots[i]!;
    let st;
    try {
      st = await stat(root);
    } catch {
      continue;
    }
    if (!st?.isDirectory()) continue;

    const files: string[] = [];
    await walkMarkdownFiles(root, files);
    files.sort((a, b) => b.localeCompare(a, "en"));

    for (const absolutePath of files) {
      const raw = await readFile(absolutePath, "utf8");
      const { fields, malformed } = parseMarkdownFrontmatter(raw);
      if (malformed) {
        // Skip policy: malformed frontmatter is never resolvable by path.
        continue;
      }
      const idRaw = fields["id"]?.trim();
      const fileId = idRaw && idRaw.length > 0 ? idRaw : pathSlugId(root, absolutePath);
      if (fileId === id) return absolutePath;
    }
  }
  return undefined;
}
