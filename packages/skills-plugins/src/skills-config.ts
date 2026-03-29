import type { ShoggothConfig } from "@shoggoth/shared";
import { resolveLocalPluginPath } from "./load-plugins-from-config";
import { scanSkillDirectories } from "./scan-skills";
import type { SkillRecord } from "./scan-skills";

export function resolveSkillScanRoots(
  config: Pick<ShoggothConfig, "skills" | "configDirectory">,
): string[] {
  return config.skills.scanRoots.map((r) => resolveLocalPluginPath(r, config.configDirectory));
}

export function listSkillsForConfig(config: ShoggothConfig): SkillRecord[] {
  const roots = resolveSkillScanRoots(config);
  const disabled = new Set(config.skills.disabledIds);
  return scanSkillDirectories(roots, disabled);
}

export function skillAbsolutePathById(config: ShoggothConfig, id: string): string | undefined {
  const roots = resolveSkillScanRoots(config);
  const all = scanSkillDirectories(roots, new Set());
  return all.find((s) => s.id === id)?.absolutePath;
}
