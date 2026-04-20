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
