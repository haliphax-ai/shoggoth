/**
 * Dispatcher for workflow tool execution.
 * Routes tool calls to per-session executors based on the executing session context.
 */

import type { ToolExecutor } from "@shoggoth/workflow";
import { getLogger } from "./logging";

const log = getLogger("workflow-tool-dispatcher");

/**
 * Creates a tool executor dispatcher that routes calls to per-session executors.
 * Maintains a map of toolCallId -> sessionId to track which session is executing which tool.
 */
export function createWorkflowToolDispatcher(
  createSessionExecutor: (sessionId: string) => ToolExecutor,
): ToolExecutor & { registerToolCall: (toolCallId: string, sessionId: string) => void } {
  const toolCallToSession = new Map<string, string>();
  const executorCache = new Map<string, ToolExecutor>();

  return {
    registerToolCall(toolCallId: string, sessionId: string): void {
      toolCallToSession.set(toolCallId, sessionId);
      log.debug("tool call registered", { toolCallId, sessionId });
    },

    async execute({ name, argsJson, toolCallId }) {
      const sessionId = toolCallToSession.get(toolCallId);
      if (!sessionId) {
        log.warn("tool call not registered", { toolCallId, tool: name });
        return {
          resultJson: JSON.stringify({
            error: "session_not_found",
            tool: name,
            message: `Tool call ${toolCallId} not registered with a session`,
          }),
        };
      }

      // Get or create executor for this session
      let executor = executorCache.get(sessionId);
      if (!executor) {
        executor = createSessionExecutor(sessionId);
        executorCache.set(sessionId, executor);
      }

      try {
        const result = await executor.execute({ name, argsJson, toolCallId });
        // Clean up after execution
        toolCallToSession.delete(toolCallId);
        return result;
      } catch (e) {
        log.error("tool execution failed", { toolCallId, sessionId, tool: name, error: String(e) });
        toolCallToSession.delete(toolCallId);
        return {
          resultJson: JSON.stringify({
            error: "execution_failed",
            tool: name,
            message: e instanceof Error ? e.message : String(e),
          }),
        };
      }
    },
  };
}
