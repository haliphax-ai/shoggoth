import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { ChatMessage } from "@shoggoth/models";
import {
  createFailoverToolCallingClientFromModelsConfig,
  mergeModelInvocationParams,
  type CreateFailoverFromConfigOptions,
  type FailoverToolCallingClient,
} from "@shoggoth/models";
import type { AgentCredentials } from "@shoggoth/os-exec";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  isSubagentSessionUrn,
  resolveEffectiveMemoryForSession,
  resolveEffectiveModelsConfig,
  stripFalsifiedSystemContext,
  wrapWithSystemContext,
  type SystemContext,
} from "@shoggoth/shared";
import { mergeOrchestratorEnv } from "../config/effective-runtime";
import { getAgentIntegrationInvoker } from "../control/agent-integration-invoke-ref";
import { getProcessManager } from "../process-manager-singleton";
import { BuiltinToolRegistry, type BuiltinToolContext } from "./builtin-tool-registry";
import { registerAllBuiltinHandlers } from "./builtin-handlers/index";
import { createMcpRoutingToolExecutor } from "../mcp/tool-loop-mcp";
import { createToolLoopPolicyAndAudit } from "../policy/tool-loop-bridge";
import { createDefaultSubResourceRegistry } from "../policy/sub-resource";
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
import {
  beginSessionTurnAbortScope,
  TurnAbortedError,
} from "./session-turn-abort";
import { messageToolContextRef } from "../messaging/message-tool-context-ref";
import { recordAgentTurn } from "./session-stats-store";
import { checkContextWindowMismatch } from "./context-window-mismatch";
import { getModelContextWindowTokens } from "../model-metadata";
import { drainSystemContext, pushSystemContext } from "./system-context-buffer";
import { getLogger } from "../logging";


export interface ExecuteSessionAgentTurnInput {
  readonly db: Database.Database;
  readonly sessionId: string;
  readonly session: SessionRow;
  readonly transcript: TranscriptStore;
  readonly toolRuns: ToolRunStore;
  readonly userContent: string;
  readonly userMetadata: Record<string, unknown> | undefined;
  readonly systemContext?: SystemContext;
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

// Module-level registry — handlers are stateless; all per-invocation state
// flows through BuiltinToolContext.
const builtinRegistry = new BuiltinToolRegistry();
registerAllBuiltinHandlers(builtinRegistry);

/**
 * Appends the user turn, runs the tool loop with MCP + built-ins, and returns the latest
 * assistant text plus failover metadata. Caller handles message-platform delivery and formatting.
 * CI/non-platform entrypoint: `test/sessions/session-agent-turn.test.ts` (mocked model client).
 */
export async function executeSessionAgentTurn(
  input: ExecuteSessionAgentTurnInput,
): Promise<SessionAgentTurnResult> {
  const log = getLogger("session-agent-turn");
  log.debug("executeSessionAgentTurn entered", { sessionId: input.sessionId });

  // Drain any buffered system context entries and prepend to the system prompt.
  const buffered = drainSystemContext(input.sessionId);
  const effectiveSystemPrompt = buffered.length > 0
    ? buffered.join("\n") + "\n\n" + input.systemPrompt
    : input.systemPrompt;

  const loopImpl = input.loopImpl ?? runToolLoop;
  const ctxSeg = input.session.contextSegmentId.trim();
  if (!ctxSeg) {
    throw new Error("executeSessionAgentTurn: session.contextSegmentId must be non-empty");
  }

  const sessionToken = input.session.systemContextToken;
  const sanitizedUserContent = stripFalsifiedSystemContext(input.userContent, sessionToken);

  const effectiveContent = input.systemContext
    ? wrapWithSystemContext(sanitizedUserContent, input.systemContext, sessionToken ?? (() => { throw new Error("systemContextToken is required when systemContext is provided"); })())
    : sanitizedUserContent;

  input.transcript.append({
    sessionId: input.sessionId,
    contextSegmentId: ctxSeg,
    role: "user",
    content: effectiveContent,
    metadata: input.userMetadata ?? {},
    systemContext: input.systemContext,
  });

  const history = loadSessionTranscriptAsModelChat(input.db, input.sessionId, ctxSeg);
  const system: ChatMessage = {
    role: "system",
    content: effectiveSystemPrompt,
  };
  const initialMessages: ChatMessage[] = [system, ...history];

  log.debug("resolving mcp context", { sessionId: input.sessionId });
  const mcpCtx = await input.resolveMcpContext(input.sessionId);
  log.debug("mcp context resolved", { sessionId: input.sessionId, toolCount: mcpCtx.toolsLoop.length });

  const createToolClient =
    input.createToolCallingClient ?? createFailoverToolCallingClientFromModelsConfig;
  const modelsForSession =
    resolveEffectiveModelsConfig(input.config, input.sessionId) ?? input.config.models;
  const toolClient = createToolClient(modelsForSession, { env: input.env });

  const modelInvocation = mergeModelInvocationParams(modelsForSession, input.session.modelSelection);

  const model: SessionToolLoopModelClient = createSessionToolLoopModelClient({
    toolClient,
    initialMessages,
    tools: mcpCtx.toolsOpenAi,
    modelInvocation,
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
        const toolCtx: BuiltinToolContext = {
          sessionId: input.sessionId,
          db: input.db,
          config: input.config,
          env: input.env,
          workspacePath: input.session.workspacePath,
          creds,
          orchestratorEnv,
          getAgentIntegrationInvoker,
          getProcessManager,
          messageToolCtx: messageToolContextRef.current ?? undefined,
          memoryConfig: resolveEffectiveMemoryForSession(input.config, input.sessionId),
          runtimeOpenaiBaseUrl: input.config.runtime?.openaiBaseUrl,
          isSubagentSession: isSubagentSessionUrn(input.sessionId),
        };
        if (builtinRegistry.has(originalName)) {
          return builtinRegistry.execute(originalName, args, toolCtx);
        }
        // Preserve the original error for unrecognised session.* names
        if (originalName.startsWith("session-")) {
          return { resultJson: JSON.stringify({ error: `unknown integration builtin: ${originalName}` }) };
        }
        return { resultJson: JSON.stringify({ error: `unknown builtin: ${originalName}` }) };
      } catch (e) {
        return { resultJson: JSON.stringify({ error: String(e) }) };
      }
    },
  });

  const { signal: turnAbortSignal, end: endTurnAbortScope } = beginSessionTurnAbortScope(
    input.sessionId,
  );
  log.debug("model call started", {
    sessionId: input.sessionId,
    messageCount: initialMessages.length,
    toolCount: mcpCtx.toolsLoop.length,
    systemPromptLen: input.systemPrompt.length,
    totalContentLen: initialMessages.reduce((n, m) => n + (m.content?.length ?? 0), 0),
    model: modelInvocation?.model ?? "default",
    isSubagent: isSubagentSessionUrn(input.sessionId),
  });
  try {
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
      contextSegmentId: ctxSeg,
      turnAbortSignal,
      subResourceRegistry: createDefaultSubResourceRegistry(),
      hitl: {
        ...input.hitl,
        config: input.getHitlConfig(),
      },
    });
  } catch (e) {
    if (e instanceof TurnAbortedError) {
      pushSystemContext(input.sessionId, "Previous turn was aborted. Results may be partial.");
      const failoverMeta = model.getSessionToolLoopFailoverState();
      const latestAssistantText =
        extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "_Aborted._";
      return { failoverMeta, latestAssistantText };
    }
    throw e;
  } finally {
    endTurnAbortScope();
  }

  const failoverMeta = model.getSessionToolLoopFailoverState();
  const latestAssistantText =
    extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "_No reply text._";

  log.debug("model response received", {
    sessionId: input.sessionId,
    model: failoverMeta?.usedModel,
    contentLength: latestAssistantText.length,
    degraded: failoverMeta?.degraded,
  });

  // --- Session stats: record completed agent turn ---
  const accumulatedUsage = model.getAccumulatedUsage();

  // Fall back to metadata store for context window if provider didn't report it
  let contextWindowTokens = accumulatedUsage?.contextWindowTokens;
  if (contextWindowTokens == null && failoverMeta) {
    contextWindowTokens = getModelContextWindowTokens(failoverMeta.usedProviderId, failoverMeta.usedModel ?? "");
  }

  const transcriptMessageCount = (
    input.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM transcript_messages
         WHERE session_id = @sessionId AND context_segment_id = @ctxSeg`,
      )
      .get({ sessionId: input.sessionId, ctxSeg }) as { cnt: number }
  ).cnt;

  recordAgentTurn(input.db, input.sessionId, {
    inputTokens: accumulatedUsage?.inputTokens ?? 0,
    outputTokens: accumulatedUsage?.outputTokens ?? 0,
    contextWindowTokens,
    transcriptMessageCount,
  });

  // --- Context window mismatch check ---
  if (failoverMeta) {
    checkContextWindowMismatch({
      providerId: failoverMeta.usedProviderId,
      configContextWindow: undefined, // TODO: extract from model config when available
      providerContextWindow: contextWindowTokens,
      sessionId: input.sessionId,
      // TODO: wire surfaceWarning to platform binding
      surfaceWarning: undefined,
      suppressNotice: input.config.runtime?.suppressContextWindowMismatchNotice,
    });
  }

  return { failoverMeta, latestAssistantText };
}
