// This is the new adapter code to be inserted into workflow-adapters.ts
// Insert this BEFORE the "// ToolExecutor (for workflow tool tasks)" section

// ---------------------------------------------------------------------------
// WorkflowToolExecutorAdapter (converts daemon tool context to workflow ToolExecutor)
// ---------------------------------------------------------------------------

export interface WorkflowToolExecutorAdapterDeps {
  readonly sessionId: string;
  readonly getToolContext: () => Promise<import("./sessions/session-mcp-tool-context").SessionMcpToolContext | undefined>;
  readonly logger: ReturnType<typeof getLogger>;
}

/**
 * Adapter that converts the daemon's tool context interface to the workflow ToolExecutor interface.
 * Workflow tasks call execute(tool, args) and expect { ok, output, error }.
 * The daemon's tool context expects { name, argsJson, toolCallId } and returns { resultJson }.
 */
export function createWorkflowToolExecutorAdapter(deps: WorkflowToolExecutorAdapterDeps): ToolExecutor {
  const logger = adaptLogger(deps.logger);

  return {
    async execute(tool: string, args: Record<string, unknown>) {
      const argsJson = JSON.stringify(args);
      const toolCallId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      logger.debug("workflow tool task executing", { tool, sessionId: deps.sessionId, argsLen: argsJson.length });

      try {
        const context = await deps.getToolContext();
        if (!context) {
          logger.warn("workflow tool task: no context available", { tool, sessionId: deps.sessionId });
          return { ok: false, output: "", error: "Tool context not available" };
        }

        const result = await context.execute({ name: tool, argsJson, toolCallId });
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(result.resultJson);
        } catch (e) {
          logger.warn("workflow tool task: failed to parse result", { tool, sessionId: deps.sessionId, error: String(e) });
          return { ok: false, output: "", error: "Tool returned invalid JSON" };
        }

        // Check if the result indicates an error
        if (parsed.error) {
          const errorMsg = (parsed.message as string | undefined) || (parsed.error as string);
          logger.debug("workflow tool task: tool returned error", { tool, sessionId: deps.sessionId, error: errorMsg });
          return { ok: false, output: "", error: errorMsg };
        }

        logger.debug("workflow tool task completed", { tool, sessionId: deps.sessionId });
        return { ok: true, output: result.resultJson };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logger.warn("workflow tool task failed", { tool, sessionId: deps.sessionId, error: errMsg });
        return { ok: false, output: "", error: errMsg };
      }
    },
  };
}
