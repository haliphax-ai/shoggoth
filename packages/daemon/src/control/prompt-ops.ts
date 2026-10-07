import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Default global prompts folder (overridable via config `prompts.globalDir`). */
export const DEFAULT_GLOBAL_PROMPTS_DIR = "/var/lib/shoggoth/shared/prompts";

/** Slug charset: filename-safe, no path separators (blocks traversal). */
const PROMPT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `${placeholderName}` pattern. */
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class PromptOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromptOpError";
  }
}

export function assertValidPromptSlug(slug: string): void {
  if (!PROMPT_SLUG_RE.test(slug) || slug.includes("..")) {
    throw new PromptOpError("ERR_INVALID_PAYLOAD", `invalid prompt slug: ${JSON.stringify(slug)}`);
  }
}

/**
 * Locate `<slug>.md`: `<workspace>/prompts/` → `<workspace>/` → `<globalPromptsDir>/`.
 * Returns undefined when not found anywhere. Throws on invalid slugs.
 */
export function resolvePromptFile(
  workspaceDir: string | undefined,
  globalPromptsDir: string | undefined,
  slug: string,
): string | undefined {
  assertValidPromptSlug(slug);
  const file = `${slug}.md`;
  const candidates: string[] = [];
  if (workspaceDir) {
    candidates.push(join(workspaceDir, "prompts", file));
    candidates.push(join(workspaceDir, file));
  }
  const globalDir = globalPromptsDir?.trim() || DEFAULT_GLOBAL_PROMPTS_DIR;
  candidates.push(join(globalDir, file));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/** Unique placeholder names in first-appearance order. */
export function scanPromptPlaceholders(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of markdown.matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Interpolate `${name}` placeholders. Every placeholder must have a key in
 * `params` — missing keys are an error listing the missing names. Empty-string
 * values are valid and substitute to "".
 */
export function renderPrompt(markdown: string, params: Record<string, string>): string {
  const placeholders = scanPromptPlaceholders(markdown);
  const missing = placeholders.filter((p) => !(p in params));
  if (missing.length > 0) {
    throw new PromptOpError(
      "ERR_MISSING_PROMPT_PARAMS",
      `missing prompt parameters: ${missing.join(", ")}`,
    );
  }
  return markdown.replace(PLACEHOLDER_RE, (_full, name: string) =>
    name in params ? params[name] : _full,
  );
}

export type PromptFileEntry = {
  readonly slug: string;
  readonly source: "workspace" | "global";
  readonly placeholders: readonly string[];
};

function listMdSlugs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((s) => PROMPT_SLUG_RE.test(s) && !s.includes(".."));
  } catch {
    return [];
  }
}

/**
 * Union of workspace prompts (`prompts/` dir, then workspace root) and global
 * prompts, deduped by slug (workspace wins over global; `prompts/` wins over
 * root), sorted by slug.
 */
export function listPromptFiles(
  workspaceDir: string | undefined,
  globalPromptsDir: string | undefined,
): PromptFileEntry[] {
  const bySlug = new Map<string, PromptFileEntry>();
  const globalDir = globalPromptsDir?.trim() || DEFAULT_GLOBAL_PROMPTS_DIR;
  const readPlaceholders = (path: string): readonly string[] => {
    try {
      return scanPromptPlaceholders(readFileSync(path, "utf8"));
    } catch {
      return [];
    }
  };
  for (const slug of listMdSlugs(globalDir)) {
    bySlug.set(slug, {
      slug,
      source: "global",
      placeholders: readPlaceholders(join(globalDir, `${slug}.md`)),
    });
  }
  if (workspaceDir) {
    for (const slug of listMdSlugs(workspaceDir)) {
      bySlug.set(slug, {
        slug,
        source: "workspace",
        placeholders: readPlaceholders(join(workspaceDir, `${slug}.md`)),
      });
    }
    for (const slug of listMdSlugs(join(workspaceDir, "prompts"))) {
      bySlug.set(slug, {
        slug,
        source: "workspace",
        placeholders: readPlaceholders(join(workspaceDir, "prompts", `${slug}.md`)),
      });
    }
  }
  return [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
