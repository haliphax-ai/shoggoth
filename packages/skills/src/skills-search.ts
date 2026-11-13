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
  /** Maximum number of results to return. Omit (or pass `Infinity`) for all
   *  results. @default Number.POSITIVE_INFINITY */
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

/** Case-insensitive substring match score.  Returns the number of times
 * `needle` appears in `haystack`, or 0 if absent.
 *
 * Both arguments must already be lowercased by the caller: this helper runs
 * once per skill field per search, so inputs are lowercased once per field
 * (in {@link scoreSkill}) instead of on every match attempt here.
 */
function substringScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Scores a single skill against a free-text query.  Matches against id,
 * title, description, and tags with weighted relevance.
 */
function scoreSkill(skill: SkillRecord, query: string): number {
  if (!query) return 0;
  // `query` arrives already lowercased (the caller normalizes it once);
  // lowercase each skill field once so `substringScore` never re-lowercases
  // per match attempt.
  const id = skill.id.toLowerCase();
  const title = skill.title.toLowerCase();
  const description = skill.description?.toLowerCase() ?? null;
  const category = skill.category?.toLowerCase() ?? null;
  const tags = skill.tags.length > 0 ? skill.tags.map((tag) => tag.toLowerCase()) : [];

  // Weighted: id/title matches are most valuable, then description, then tags.
  let score = 0;
  score += substringScore(id, query) * 3;
  score += substringScore(title, query) * 3;
  if (description) {
    score += substringScore(description, query) * 2;
  }
  if (tags.length > 0) {
    for (const tag of tags) {
      score += substringScore(tag, query) * 1;
    }
  }
  if (category) {
    score += substringScore(category, query) * 1;
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
    limit = Number.POSITIVE_INFINITY,
    offset = 0,
  } = params;

  const normalizedQuery = query?.trim().toLowerCase() ?? null;
  const normalizedTags = tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  const normalizedCategory = category?.trim().toLowerCase() ?? null;

  const results: SkillSearchResult[] = [];

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
