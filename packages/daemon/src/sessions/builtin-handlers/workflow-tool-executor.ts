/**
 * Workflow tool executor — routes tool calls to builtin and external MCP tools.
 *
 * This is the proper implementation that integrates with the daemon's tool execution
 * infrastructure, replacing the broken message-tool-based approach.
 */

import type Database from "better-sqlite3";
import type { ShoggothConfig, ShoggothMemoryConfig } from "@shoggoth/shared";
import type { AgentCredentials } from "@shoggoth/os-exec";
import type { ProcessManager } from "@shoggoth/procman";
import type { ChatContentPart, ImageBlockCodec } from "@shoggoth/models";
import type { AgentIntegrationInvoker } from "../../control/integration-invoke";
import type { BuiltinToolRegistry, BuiltinToolContext, MessageToolCtx } from "../builtin-tool-registry";
import type { SessionMcpToolContext } from "../session-mcp-tool-context";
import type { ToolExecutor } from "../tool-loop";
import { createMcpRoutingToolExecutor } from "../../mcp/tool-loop-mcp";
import { getLogger } from "../../logging";

const log = getLogger("workflow-tool-executor");

export interface WorkflowToolExecutorDeps {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly workspacePath: string;
  readonly workingDirectory?: string;
  readonly creds: AgentCredentials;
  readonly orchestratorEnv: NodeJS.ProcessEnv;
  readonly getAgentIntegrationInvoker: () => AgentIntegrationInvoker | undefined;
  readonly getProcessManager: () => ProcessManager | undefined;
  readonly messageToolCtx: MessageToolCtx | undefined;
  readonly memoryConfig: ShoggothMemoryConfig;
  readonly runtimeOpenaiBaseUrl: string | undefined;
  readonly isSubagentSession: boolean;
  readonly imageBlockCodec?: ImageBlockCodec;
  readonly builtinRegistry: BuiltinToolRegistry;
  readonly sessionMcpContext: SessionMcpToolContext;
}

/**
 * Creates a tool executor for workflow tasks that properly routes to builtin and external MCP tools.
 * This replaces the broken message-tool-based approach.
 */
export function createWorkflowToolExecutor(
  sessionId: string,
  deps: WorkflowToolExecutorDeps,
): ToolExecutor {
  const builtinCtx: BuiltinToolContext = {
    sessionId,
    db: deps.db,
    config: deps.config,
    env: deps.env,
    workspacePath: deps.workspacePath,
    workingDirectory: deps.workingDirectory,
    creds: deps.creds,
    orchestratorEnv: deps.orchestratorEnv,
    getAgentIntegrationInvoker: deps.getAgentIntegrationInvoker,
    getProcessManager: deps.getProcessManager,
    messageToolCtx: deps.messageToolCtx,
    memoryConfig: deps.memoryConfig,
    runtimeOpenaiBaseUrl: deps.runtimeOpenaiBaseUrl,
    isSubagentSession: deps.isSubagentSession,
    imageBlockCodec: deps.imageBlockCodec,
  };

  return createMcpRoutingToolExecutor({
    aggregated: deps.sessionMcpContext.aggregated,
    builtin: async ({ originalName, argsJson, toolCallId }) => {
      log.debug("workflow tool: executing builtin", { tool: originalName, toolCallId, sessionId });
      try {
        const result = await deps.builtinRegistry.execute(originalName, JSON.parse(argsJson), builtinCtx);
        log.debug("workflow tool: builtin completed", { tool: originalName, toolCallId, sessionId });
        return result;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.warn("workflow tool: builtin failed", { tool: originalName, toolCallId, sessionId, error: errMsg });
        return {
          resultJson: JSON.stringify({
            error: "tool_execution_failed",
            tool: originalName,
            message: errMsg,
          }),
        };
      }
    },
    external: deps.sessionMcpContext.external,
  });
}
