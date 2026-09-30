import { getLogger } from "@shoggoth/shared";
import type { InternalMessage } from "./model";

const log = getLogger("messaging");

export type AgentToAgentHandler = (message: InternalMessage) => void;

export interface AgentToAgentBus {
  subscribe(targetSessionId: string, handler: AgentToAgentHandler): () => void;
  /**
   * Dispatch a message to every subscriber of `targetSessionId`.
   *
   * @returns `true` when at least one subscriber received the message,
   * `false` when the message was dropped because no subscriber is registered
   * for the target (a debug-level log record is emitted on drop).
   */
  deliver(targetSessionId: string, message: InternalMessage): boolean;
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

    deliver(targetSessionId: string, message: InternalMessage): boolean {
      const set = byTarget.get(targetSessionId);
      if (!set || set.size === 0) {
        log.debug("a2a.deliver.no_subscribers", {
          targetSessionId,
          messageId: message.id,
        });
        return false;
      }
      for (const handler of set) {
        handler(message);
      }
      return true;
    },
  };
}
