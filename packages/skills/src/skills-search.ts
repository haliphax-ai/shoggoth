import type { SkillRecord } from "./scan-skills";

/** Parameters accepted by {@link searchSkills}. All optional — omitting
 *  everything returns the full list (backward-compatible). */
export interface SkillSearchParams {
  /** Free-text search against skill name/id, description, and tags. */
  readonly query?: string | null;
  /** Filter to skills matching ALL provided tags (AND logic). */
  readonly tags?: readonly string[];
  /** Filter to skills in a specific category. */
  readonly category?: string | null;
  /** Maximum number of results to return. @default 10 */
  readonly limit?: number;
  /** Pagination offset for large result sets. @default 0 */
  readonly offset?: number;
}

/** A search result entry — the full {@link SkillRecord} plus a relevance score. */
export interface SkillSearchResult {
  readonly skill: SkillRecord;
  /** Simple relevance score (higher = better match). Only meaningful when
   *  a `query` is provided; otherwise every result scores 0. */
  readonly score: number;
}

/**
 * Case-insensitive substring match score.  Returns the number of times
 * `needle` appears in `haystack`, or 0 if absent.
 */
function substringScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = h.indexOf(n, idx)) !== -1) {
    count++;
    idx += n.length;
  }
  return count;
}

/**
 * Scores a single skill against a free-text query.  Matches against id,
 * title, description, and tags with weighted relevance.
 */
function scoreSkill(skill: SkillRecord, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();

  // Weighted: id/title matches are most valuable, then description, then tags.
  let score = 0;
  score += substringScore(skill.id, q) * 3;
  score += substringScore(skill.title, q) * 3;
  if (skill.description) {
    score += substringScore(skill.description, q) * 2;
  }
  for (const tag of skill.tags) {
    score += substringScore(tag, q) * 1;
  }
  if (skill.category) {
    score += substringScore(skill.category, q) * 1;
  }
  return score;
}

/**
 * Search and filter a list of {@link SkillRecord}s.
 *
 * When no parameters are provided the full list is returned, preserving
 * backward compatibility with the existing skill-listing behavior.
 */
export function searchSkills(
  skills: readonly SkillRecord[],
  params: SkillSearchParams = {},
): SkillSearchResult[] {
  const {
    query = null,
    tags = [],
    category = null,
    limit = 10,
    offset = 0,
  } = params;

  const normalizedQuery = query?.trim().toLowerCase() ?? null;
  const normalizedTags = tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  const normalizedCategory = category?.trim().toLowerCase() ?? null;

  let results: SkillSearchResult[] = [];

  for (const skill of skills) {
    // --- Tag filter (AND logic) ---
    if (normalizedTags.length > 0) {
      const skillTagSet = new Set(skill.tags);
      if (!normalizedTags.every((t) => skillTagSet.has(t))) continue;
    }

    // --- Category filter ---
    if (normalizedCategory && skill.category !== normalizedCategory) continue;

    // --- Query scoring ---
    const score = normalizedQuery ? scoreSkill(skill, normalizedQuery) : 0;

    // When a query is provided, exclude skills with zero relevance.
    if (normalizedQuery && score === 0) continue;

    results.push({ skill, score });
  }

  // Sort by score descending, then by id ascending for stable ordering.
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.id.localeCompare(b.skill.id, "en");
  });

  // Apply pagination.
  return results.slice(offset, offset + limit);
}
