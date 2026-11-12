import { readFileSync } from "node:fs";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  listSkillsForConfig,
  skillAbsolutePathById,
  searchSkills,
  type SkillSearchParams,
} from "@shoggoth/skills";

export function formatSkillsListJson(config: ShoggothConfig): string {
  const rows = listSkillsForConfig(config).map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    path: s.absolutePath,
    enabled: s.enabled,
  }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

export function formatSkillPathLine(config: ShoggothConfig, id: string): string {
  const p = skillAbsolutePathById(config, id);
  if (!p) {
    throw new Error(`unknown skill id: ${id}`);
  }
  return `${p}\n`;
}

/**
 * Search/filter skills and return JSON results.  When no search params are
 * provided the full list is returned (backward-compatible).
 */
export function formatSkillsSearchJson(
  config: ShoggothConfig,
  params: SkillSearchParams = {},
): string {
  const all = listSkillsForConfig(config);
  const results = searchSkills(all, params);
  const rows = results.map((r) => ({
    id: r.skill.id,
    title: r.skill.title,
    path: r.skill.absolutePath,
    enabled: r.skill.enabled,
    tags: r.skill.tags,
    category: r.skill.category,
    description: r.skill.description,
    score: r.score,
  }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

export function formatSkillReadJson(config: ShoggothConfig, id: string): string {
  const p = skillAbsolutePathById(config, id);
  if (!p) {
    throw new Error(`unknown skill id: ${id}`);
  }
  const content = readFileSync(p, "utf8");
  return `${JSON.stringify({ path: p, content }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Arg parsing for `skills search`
// ---------------------------------------------------------------------------

type SearchParseOk = {
  ok: true;
  params: {
    query?: string;
    tags?: string[];
    category?: string;
    limit?: number;
    offset?: number;
  };
};
type SearchParseErr = { ok: false; error: string };

export function parseSkillsSearchArgs(args: string[]): SearchParseOk | SearchParseErr {
  let query: string | undefined;
  const tags: string[] = [];
  let category: string | undefined;
  let limit: number | undefined;
  let offset: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--query") {
      query = args[++i];
    } else if (a === "--tag") {
      const v = args[++i];
      if (!v) return { ok: false, error: "--tag must not be empty" };
      tags.push(v);
    } else if (a === "--category") {
      category = args[++i];
    } else if (a === "--limit") {
      const raw = args[++i];
      limit = Number(raw);
      if (!raw || !Number.isInteger(limit) || limit < 1) {
        return { ok: false, error: `--limit must be a positive integer, got "${raw}"` };
      }
    } else if (a === "--offset") {
      const raw = args[++i];
      offset = Number(raw);
      if (!raw || !Number.isInteger(offset) || offset < 0) {
        return { ok: false, error: `--offset must be a non-negative integer, got "${raw}"` };
      }
    }
    // Unknown flags are ignored, consistent with the other CLI arg parsers.
  }

  const params: {
    query?: string;
    tags?: string[];
    category?: string;
    limit?: number;
    offset?: number;
  } = {};
  if (query != null) params.query = query;
  if (tags.length > 0) params.tags = tags;
  if (category != null) params.category = category;
  if (limit != null) params.limit = limit;
  if (offset != null) params.offset = offset;
  return { ok: true, params };
}
