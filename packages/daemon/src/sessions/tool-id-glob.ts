// ---------------------------------------------------------------------------
// Tool ID glob matching — `*` (any sequence) and `?` (single character)
// ---------------------------------------------------------------------------

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** True when a pattern contains `*` or `?` wildcards. */
export function isGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/**
 * Match a tool ID against a pattern. Patterns without wildcards must equal the
 * tool ID exactly; with wildcards the pattern must match the entire ID.
 */
export function toolIdGlobMatches(pattern: string, toolId: string): boolean {
  if (!isGlobPattern(pattern)) return pattern === toolId;
  const source = pattern.replace(REGEX_SPECIALS, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(toolId);
}

/** Tool IDs matched by a single pattern. */
export function matchToolIds(pattern: string, toolIds: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of toolIds) {
    if (toolIdGlobMatches(pattern, id)) out.push(id);
  }
  return out;
}
