import type { ShoggothConfig } from "@shoggoth/shared";
import { LAYOUT } from "@shoggoth/shared";
import { isAbsolute, resolve } from "node:path";
import { findSkillPathById, scanSkillDirectories } from "./scan-skills";
import type { SkillRecord } from "./scan-skills";

/**
 * Resolve configured scanRoots relative to the data root (/var/lib/shoggoth).
 * Absolute paths pass through unchanged.
 */
export function resolveSkillScanRoots(config: Pick<ShoggothConfig, "skills">): string[] {
  return config.skills.scanRoots.map((r) => (isAbsolute(r) ? r : resolve(LAYOUT.dataRoot, r)));
}

/**
 * List all skills from configured roots + the agent workspace skills folder.
 * Last skill loaded with the same id wins; workspace skills are scanned last.
 */
export async function listSkillsForConfig(
  config: ShoggothConfig,
  workspacePath?: string,
): Promise<SkillRecord[]> {
  const roots = resolveSkillScanRoots(config);
  if (workspacePath) {
    roots.push(resolve(workspacePath, "skills"));
  }
  const disabled = new Set(config.skills.disabledIds);
  return scanSkillDirectories(roots, disabled);
}

export async function skillAbsolutePathById(
  config: ShoggothConfig,
  id: string,
  workspacePath?: string,
): Promise<string | undefined> {
  const roots = resolveSkillScanRoots(config);
  if (workspacePath) {
    roots.push(resolve(workspacePath, "skills"));
  }
  return findSkillPathById(roots, id);
}
