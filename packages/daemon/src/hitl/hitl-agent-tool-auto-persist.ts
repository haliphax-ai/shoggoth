import {
  DEFAULT_HITL_CONFIG,
  loadLayeredConfig,
  type ShoggothConfig,
} from "@shoggoth/shared";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HitlConfigRef } from "../config-hot-reload";

/** Sorts late in layered merge; holds full `hitl.agentToolAutoApprove` map after each ♾️ update. */
export const HITL_AGENT_TOOL_AUTO_APPROVE_FILENAME = "z-hitl-agent-tool-auto-approve.json";

export function persistAgentToolAutoApproveAndReload(input: {
  readonly configDirectory: string;
  readonly dynamicConfigDirectory: string;
  readonly configRef: { current: ShoggothConfig };
  readonly hitlRef: HitlConfigRef;
  readonly agentId: string;
  readonly toolName: string;
}): void {
  const dir = input.configDirectory.trim();
  const dynDir = input.dynamicConfigDirectory.trim();
  if (!dir) throw new Error("configDirectory required");
  if (!dynDir) throw new Error("dynamicConfigDirectory required");
  mkdirSync(dynDir, { recursive: true });
  const merged = loadLayeredConfig(dir).hitl.agentToolAutoApprove;
  const aid = input.agentId.trim();
  const tn = input.toolName.trim();
  const cur = new Set(merged[aid] ?? []);
  cur.add(tn);
  const nextMap: Record<string, string[]> = { ...merged, [aid]: [...cur].sort() };
  const body = `${JSON.stringify({ hitl: { agentToolAutoApprove: nextMap } }, null, 2)}\n`;
  const full = join(dynDir, HITL_AGENT_TOOL_AUTO_APPROVE_FILENAME);
  const tmp = `${full}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, full);
  const next = loadLayeredConfig(dir);
  input.configRef.current = next;
  input.hitlRef.value = { ...DEFAULT_HITL_CONFIG, ...next.hitl };
}

/**
 * Rewrite `z-hitl-agent-tool-auto-approve.json` with a new `agentToolAutoApprove` map and reload config.
 * Use empty arrays per agent to clear entries (layered merge cannot remove keys with `{}`).
 */
export function rewriteAgentToolAutoApproveMapAndReload(input: {
  readonly configDirectory: string;
  readonly dynamicConfigDirectory: string;
  readonly configRef: { current: ShoggothConfig };
  readonly hitlRef: HitlConfigRef;
  readonly nextAgentToolAutoApprove: Record<string, string[]>;
}): void {
  const dir = input.configDirectory.trim();
  const dynDir = input.dynamicConfigDirectory.trim();
  if (!dir) throw new Error("configDirectory required");
  if (!dynDir) throw new Error("dynamicConfigDirectory required");
  mkdirSync(dynDir, { recursive: true });
  const body = `${JSON.stringify({ hitl: { agentToolAutoApprove: input.nextAgentToolAutoApprove } }, null, 2)}\n`;
  const full = join(dynDir, HITL_AGENT_TOOL_AUTO_APPROVE_FILENAME);
  const tmp = `${full}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, full);
  const next = loadLayeredConfig(dir);
  input.configRef.current = next;
  input.hitlRef.value = { ...DEFAULT_HITL_CONFIG, ...next.hitl };
}
