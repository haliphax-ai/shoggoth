import { parseAgentSessionUrn, resolveTopLevelSessionUrn } from "@shoggoth/shared";

/**
 * In-memory gates: after ✅ / ♾️ approval, future calls for the **same tool name** in that scope
 * skip HITL (until daemon restart). Scoped per tool, not all tools.
 */
export type HitlAutoApproveGate = {
  enableSessionTool(sessionId: string, toolName: string): void;
  enableAgentTool(agentId: string, toolName: string): void;
  shouldAutoApprove(sessionId: string, toolName: string): boolean;
  /**
   * Daemon persisting gate only: drop in-process ♾️ entries (optional).
   * Used by `hitl_clear` so auto-approve state matches disk after a wipe.
   */
  clearAutoApproveMemory?(input: { readonly agents: "all" | readonly string[] }): void;
};

export function createHitlAutoApproveGate(): HitlAutoApproveGate {
  const sessionTools = new Map<string, Set<string>>();
  const agentTools = new Map<string, Set<string>>();

  function addTo(map: Map<string, Set<string>>, key: string, tool: string): void {
    let s = map.get(key);
    if (!s) {
      s = new Set();
      map.set(key, s);
    }
    s.add(tool);
  }

  return {
    enableSessionTool(sessionId: string, toolName: string) {
      addTo(sessionTools, sessionId.trim(), toolName.trim());
    },
    enableAgentTool(agentId: string, toolName: string) {
      addTo(agentTools, agentId.trim(), toolName.trim());
    },
    shouldAutoApprove(sessionId: string, toolName: string) {
      const sid = sessionId.trim();
      const t = toolName.trim();
      if (sessionTools.get(sid)?.has(t)) return true;
      // For subagent sessions, also check the top-level (main) session's approvals.
      const mainSid = resolveTopLevelSessionUrn(sid);
      if (mainSid && sessionTools.get(mainSid)?.has(t)) return true;
      const p = parseAgentSessionUrn(sid);
      return p ? (agentTools.get(p.agentId)?.has(t) ?? false) : false;
    },
  };
}
