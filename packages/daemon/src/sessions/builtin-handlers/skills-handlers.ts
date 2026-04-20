// ---------------------------------------------------------------------------
// skills handler
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { listSkillsForConfig, skillAbsolutePathById } from "@shoggoth/skills";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("skills", skills);
}

async function skills(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const action = String(args.action ?? "").trim();
  const ws = ctx.workspacePath;
  if (action === "list") {
    const rows = listSkillsForConfig(ctx.config, ws).map((s) => ({
      id: s.id,
      title: s.title,
      path: s.absolutePath,
      enabled: s.enabled,
    }));
    return { resultJson: JSON.stringify(rows) };
  }
  const id = String(args.id ?? "").trim();
  if (!id) {
    return { resultJson: JSON.stringify({ error: "id required for path and read actions" }) };
  }
  if (action === "path") {
    const p = skillAbsolutePathById(ctx.config, id, ws);
    if (!p) return { resultJson: JSON.stringify({ error: `unknown skill id: ${id}` }) };
    return { resultJson: JSON.stringify({ path: p }) };
  }
  if (action === "read") {
    const p = skillAbsolutePathById(ctx.config, id, ws);
    if (!p) return { resultJson: JSON.stringify({ error: `unknown skill id: ${id}` }) };
    const content = readFileSync(p, "utf8");
    return { resultJson: JSON.stringify({ path: p, content }) };
  }
  return { resultJson: JSON.stringify({ error: `unknown skills action: ${action}` }) };
}
