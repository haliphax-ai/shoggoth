import type { InternalMessage } from "./model";

export type AgentToAgentHandler = (message: InternalMessage) => void;

export interface AgentToAgentBus {
  subscribe(targetSessionId: string, handler: AgentToAgentHandler): () => void;
  deliver(targetSessionId: string, message: InternalMessage): void;
}

export function createAgentToAgentBus(): AgentToAgentBus {
  const byTarget = new Map<string, Set<AgentToAgentHandler>>();

  return {
    subscribe(targetSessionId: string, handler: AgentToAgentHandler): () => void {
      let set = byTarget.get(targetSessionId);
      if (!set) {
        set = new Set();
        byTarget.set(targetSessionId, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
        if (set!.size === 0) byTarget.delete(targetSessionId);
      };
    },

    deliver(targetSessionId: string, message: InternalMessage): void {
      const set = byTarget.get(targetSessionId);
      if (!set) return;
      for (const handler of [...set]) {
        handler(message);
      }
    },
  };
}
