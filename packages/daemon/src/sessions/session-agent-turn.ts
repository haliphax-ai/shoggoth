import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { ChatMessage } from "@shoggoth/models";
import {
  createFailoverToolCallingClientFromModelsConfig,
  type CreateFailoverFromConfigOptions,
  type FailoverToolCallingClient,
} from "@shoggoth/models";
import { toolExec, toolRead, toolWrite, type AgentCredentials } from "@shoggoth/os-exec";
import type { ShoggothConfig } from "@shoggoth/shared";
import { mergeOrchestratorEnv } from "../config/effective-runtime";
import { runMemoryBuiltin } from "../memory/builtin-memory-tools";
import { createMcpRoutingToolExecutor } from "../mcp/tool-loop-mcp";
import { createToolLoopPolicyAndAudit } from "../policy/tool-loop-bridge";
import { runToolLoop, type RunToolLoopHitl, type RunToolLoopOptions } from "./tool-loop";
import type { TranscriptStore } from "./transcript-store";
import type { ToolRunStore } from "./tool-run-store";
import type { SessionRow } from "./session-store";
import {
  extractLatestTranscriptAssistantText,
  loadSessionTranscriptAsModelChat,
} from "./transcript-to-chat";
import {
  createSessionToolLoopModelClient,
  type SessionToolLoopFailoverState,
  type SessionToolLoopModelClient,
} from "./session-tool-loop-model-client";
import type { SessionMcpToolContext } from "./session-mcp-tool-context";
import type { PolicyEngine } from "../policy/engine";

export interface ExecuteSessionAgentTurnInput {
  readonly db: Database.Database;
  readonly sessionId: string;
  readonly session: SessionRow;
  readonly transcript: TranscriptStore;
  readonly toolRuns: ToolRunStore;
  readonly userContent: string;
  readonly userMetadata: Record<string, unknown> | undefined;
  readonly systemPrompt: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: ShoggothConfig;
  readonly policyEngine: PolicyEngine;
  readonly getHitlConfig: () => ShoggothConfig["hitl"];
  readonly hitl: Omit<RunToolLoopHitl, "config">;
  readonly loopImpl?: (opts: RunToolLoopOptions) => Promise<void>;
  readonly createToolCallingClient?: (
    models: ShoggothConfig["models"],
    options?: CreateFailoverFromConfigOptions,
  ) => FailoverToolCallingClient;
  readonly resolveMcpContext: (sessionId: string) => Promise<SessionMcpToolContext>;
  readonly stream?: {
    readonly streamModel: boolean;
    readonly onModelTextDelta?: (displayText: string) => void | Promise<void>;
  };
}

export interface SessionAgentTurnResult {
  readonly failoverMeta: SessionToolLoopFailoverState | undefined;
  readonly latestAssistantText: string;
}

function sessionCreds(uid?: number, gid?: number): AgentCredentials {
  const u = uid ?? process.getuid?.() ?? 0;
  const g = gid ?? process.getgid?.() ?? 0;
  return { uid: u, gid: g };
}

/**
 * Appends the user turn, runs the tool loop with MCP + built-ins, and returns the latest
 * assistant text plus failover metadata. Caller handles message-platform delivery and formatting.
 * CI/non-Discord entrypoint: `test/sessions/session-agent-turn.test.ts` (mocked model client).
 */
export async function executeSessionAgentTurn(
  input: ExecuteSessionAgentTurnInput,
): Promise<SessionAgentTurnResult> {
  const loopImpl = input.loopImpl ?? runToolLoop;

  input.transcript.append({
    sessionId: input.sessionId,
    role: "user",
    content: input.userContent,
    metadata: input.userMetadata ?? {},
  });

  const history = loadSessionTranscriptAsModelChat(input.db, input.sessionId);
  const system: ChatMessage = {
    role: "system",
    content: input.systemPrompt,
  };
  const initialMessages: ChatMessage[] = [system, ...history];

  const mcpCtx = await input.resolveMcpContext(input.sessionId);

  const createToolClient =
    input.createToolCallingClient ?? createFailoverToolCallingClientFromModelsConfig;
  const toolClient = createToolClient(input.config.models, { env: input.env });

  const model: SessionToolLoopModelClient = createSessionToolLoopModelClient({
    toolClient,
    initialMessages,
    tools: mcpCtx.toolsOpenAi,
    streamModel: Boolean(input.stream?.streamModel),
    onModelTextDelta: input.stream?.onModelTextDelta,
  });

  const principal: AuthenticatedPrincipal = {
    kind: "agent",
    sessionId: input.sessionId,
    source: "agent",
  };

  const runId = randomUUID();
  const { policy, audit } = createToolLoopPolicyAndAudit({
    engine: input.policyEngine,
    principal,
    db: input.db,
    correlationId: runId,
  });

  const creds = sessionCreds(input.session.runtimeUid, input.session.runtimeGid);
  const orchestratorEnv = mergeOrchestratorEnv(input.config, input.env);

  const executor = createMcpRoutingToolExecutor({
    aggregated: mcpCtx.aggregated,
    ...(mcpCtx.external ? { external: mcpCtx.external } : {}),
    builtin: async ({ originalName, argsJson }) => {
      try {
        const args = JSON.parse(argsJson) as Record<string, unknown>;
        if (originalName === "read") {
          const path = String(args.path ?? "");
          const body = await toolRead(input.session.workspacePath, path, creds);
          return { resultJson: JSON.stringify({ path, content: body }) };
        }
        if (originalName === "write") {
          const path = String(args.path ?? "");
          const content = String(args.content ?? "");
          await toolWrite(input.session.workspacePath, path, content, creds);
          return { resultJson: JSON.stringify({ ok: true, path }) };
        }
        if (originalName === "exec") {
          const argv = args.argv as unknown;
          if (!Array.isArray(argv) || argv.some((x) => typeof x !== "string")) {
            return { resultJson: JSON.stringify({ error: "exec requires string argv[]" }) };
          }
          const r = await toolExec(input.session.workspacePath, argv as string[], creds);
          return {
            resultJson: JSON.stringify({
              exitCode: r.exitCode,
              stdout: r.stdout,
              stderr: r.stderr,
            }),
          };
        }
        if (originalName === "memory.search" || originalName === "memory.ingest") {
          return runMemoryBuiltin({
            originalName,
            argsJson,
            db: input.db,
            workspacePath: input.session.workspacePath,
            memory: input.config.memory,
            env: orchestratorEnv,
            runtimeOpenaiBaseUrl: input.config.runtime?.openaiBaseUrl,
          });
        }
        return { resultJson: JSON.stringify({ error: `unknown builtin: ${originalName}` }) };
      } catch (e) {
        return { resultJson: JSON.stringify({ error: String(e) }) };
      }
    },
  });

  await loopImpl({
    db: input.db,
    sessionId: input.sessionId,
    runId,
    principalId: input.sessionId,
    policy,
    audit,
    model,
    tools: mcpCtx.toolsLoop,
    executor,
    toolRuns: input.toolRuns,
    transcript: input.transcript,
    hitl: {
      ...input.hitl,
      config: input.getHitlConfig(),
    },
  });

  const failoverMeta = model.getSessionToolLoopFailoverState();
  const latestAssistantText =
    extractLatestTranscriptAssistantText(input.db, input.sessionId) ?? "_No reply text._";

  return { failoverMeta, latestAssistantText };
}
