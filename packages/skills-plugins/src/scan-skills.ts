import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseBoolField, parseMarkdownFrontmatter } from "./frontmatter";

export interface SkillRecord {
  readonly id: string;
  readonly title: string;
  readonly absolutePath: string;
  /** Effective enablement: frontmatter + config disabledIds. */
  readonly enabled: boolean;
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
  const files: string[] = [];
  for (const root of roots) {
    let st;
    try {
      st = statSync(root, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (st?.isDirectory()) {
      walkMarkdownFiles(root, files);
    }
  }
  files.sort((a, b) => a.localeCompare(b, "en"));

  const records: SkillRecord[] = [];
  for (const absolutePath of files) {
    const rootForId = roots.find((r) => {
      try {
        const rs = statSync(r, { throwIfNoEntry: false });
        return rs?.isDirectory() && absolutePath.startsWith(r);
      } catch {
        return false;
      }
    });
    const raw = readFileSync(absolutePath, "utf8");
    const { fields } = parseMarkdownFrontmatter(raw);
    const idRaw = fields["id"]?.trim();
    const id =
      idRaw && idRaw.length > 0
        ? idRaw
        : rootForId
          ? pathSlugId(rootForId, absolutePath)
          : pathSlugId(roots[0] ?? "/", absolutePath);
    const title =
      (fields["title"] ?? fields["name"] ?? "").trim() || id;
    const fileEnabled = parseBoolField(fields["enabled"], true);
    const configOk = !disabledIds.has(id);
    records.push({
      id,
      title,
      absolutePath,
      enabled: fileEnabled && configOk,
    });
  }
  return records;
}
