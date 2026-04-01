import { parseAgentSessionUrn, resolveTopLevelSessionUrn } from "@shoggoth/shared";
import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { HitlConfigRef } from "../config-hot-reload";
import type { Logger } from "../logging";
import { persistAgentToolAutoApproveAndReload } from "./hitl-agent-tool-auto-persist";
import {
  insertSessionToolAutoApprove,
  sessionHasToolAutoApproveFlexible,
} from "./hitl-session-tool-auto-store";
import type { HitlAutoApproveGate } from "./hitl-auto-approve";
import { hitlAutoApproveToolNamesMatch } from "./hitl-tool-name-match";

export function createPersistingHitlAutoApproveGate(input: {
  readonly db: Database.Database;
  readonly configDirectory: string;
  readonly dynamicConfigDirectory?: string;
  readonly configRef: { current: ShoggothConfig };
  readonly hitlRef: HitlConfigRef;
  readonly logger: Logger;
}): HitlAutoApproveGate {
  /** Process-local agent-scope auto-approve (♾️); updated before disk persist so it sticks even if JSON write fails */
  const agentToolsMem = new Map<string, Set<string>>();

  function rememberAgentTool(agentId: string, toolName: string): void {
    const aid = agentId.trim();
    const tn = toolName.trim();
    if (!aid || !tn) return;
    let s = agentToolsMem.get(aid);
    if (!s) {
      s = new Set();
      agentToolsMem.set(aid, s);
    }
    s.add(tn);
  }

  return {
    enableSessionTool(sessionId, toolName) {
      insertSessionToolAutoApprove(input.db, sessionId, toolName);
    },
    enableAgentTool(agentId, toolName) {
      rememberAgentTool(agentId, toolName);
      if (!input.dynamicConfigDirectory) {
        input.logger.warn("hitl.agent_tool_auto_approve_memory_only", {
          reason: "dynamicConfigDirectory not configured; ♾️ approval is in-memory only and will not survive restart",
          agentId,
          toolName,
        });
        return;
      }
      try {
        persistAgentToolAutoApproveAndReload({
          configDirectory: input.configDirectory,
          dynamicConfigDirectory: input.dynamicConfigDirectory,
          configRef: input.configRef,
          hitlRef: input.hitlRef,
          agentId,
          toolName,
        });
      } catch (e) {
        input.logger.warn("hitl.agent_tool_auto_persist_failed", {
          err: String(e),
          agentId,
          toolName,
        });
      }
    },
    shouldAutoApprove(sessionId, toolName) {
      const sid = sessionId.trim();
      const t = toolName.trim();
      if (sessionHasToolAutoApproveFlexible(input.db, sid, t)) return true;
      // For subagent sessions, also check the top-level (main) session's approvals.
      const mainSid = resolveTopLevelSessionUrn(sid);
      if (mainSid && sessionHasToolAutoApproveFlexible(input.db, mainSid, t)) return true;
      const p = parseAgentSessionUrn(sid);
      if (!p) return false;
      const mem = agentToolsMem.get(p.agentId);
      if (mem) {
        for (const entry of mem) {
          if (hitlAutoApproveToolNamesMatch(t, entry)) return true;
        }
      }
      const list = input.configRef.current.agents?.list?.[p.agentId]?.hitl?.toolAutoApprove;
      if (!Array.isArray(list) || list.length === 0) return false;
      for (const a of list) {
        if (hitlAutoApproveToolNamesMatch(t, a)) return true;
      }
      return false;
    },
    clearAutoApproveMemory(input) {
      if (input.agents === "all") {
        agentToolsMem.clear();
        return;
      }
      for (const a of input.agents) {
        agentToolsMem.delete(a.trim());
      }
    },
  };
}
