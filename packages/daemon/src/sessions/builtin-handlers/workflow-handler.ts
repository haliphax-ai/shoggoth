// ---------------------------------------------------------------------------
// workflow handler
// ---------------------------------------------------------------------------

import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("workflow", async (args, ctx: BuiltinToolContext) => {
    const { executeWorkflowToolCall } = await import("../../workflow-singleton.js");
    const result = await executeWorkflowToolCall(
      args as unknown as Parameters<typeof executeWorkflowToolCall>[0],
      {
        currentDepth: 0,
        maxDepth: 2,
        agentWorkspaceRoot: ctx.workspacePath,
      },
    );
    return { resultJson: JSON.stringify(result) };
  });
}
