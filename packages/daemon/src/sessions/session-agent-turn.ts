import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import { buildSessionSystemContext } from "./session-system-prompt";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { ChatMessage, ImageBlockCodec, OpenAIToolFunctionDefinition } from "@shoggoth/models";
import {
  createFailoverToolCallingClientFromModelsConfig,
  getImageBlockCodec,
  mergeModelInvocationParams,
  ModelHttpError,
  type CreateFailoverFromConfigOptions,
  type FailoverToolCallingClient,
} from "@shoggoth/models";
import type { AgentCredentials } from "@shoggoth/os-exec";
import type { ShoggothConfig, ShoggothModelsConfig } from "@shoggoth/shared";
import {
  isSubagentSessionUrn,
  resolveEffectiveMemoryForSession,
  resolveEffectiveModelsConfig,
  stripFalsifiedSystemContext,
  wrapWithSystemContext,
  type SystemContext,
} from "@shoggoth/shared";
import { mergeOrchestratorEnv, resolveToolCallTimeoutMs } from "../config/effective-runtime";
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
  sanitizeTranscriptForProvider,
} from "./transcript-to-chat";
import {
  createSessionToolLoopModelClient,
  type SessionToolLoopFailoverState,
  type SessionToolLoopModelClient,
} from "./session-tool-loop-model-client";
import type { SessionMcpToolContext } from "./session-mcp-tool-context";
import type { PolicyEngine } from "../policy/engine";
import { beginSessionTurnAbortScope, TurnAbortedError } from "./session-turn-abort";
import { messageToolContextRef } from "../messaging/message-tool-context-ref";
import {
  incrementTokenUsage,
  updateTranscriptMessageCount,
  incrementTurnCount,
} from "./session-stats-store";
import { checkContextWindowMismatch } from "./context-window-mismatch";
import { getModelContextWindowTokens } from "../model-metadata";
import { getSessionPrimaryModelRef, resolveModel } from "./model-resolution";
import { drainSystemContext, pushSystemContext } from "./system-context-buffer";
import type { OutboundAttachment } from "../presentation/platform-adapter";
import { extractShowBlocks } from "../presentation/show-blocks";
import { createTranscriptStore } from "./transcript-store";
import {
  evaluateTriggers,
  resolveToolDiscoveryConfig,
  createToolDiscoveryFinalizer,
} from "./session-tool-discovery";
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
  /** When set, this is a minimal context turn — truncate transcript to tail messages. */
  readonly minimalContext?: {
    readonly tailMessages: number;
    readonly eventContext: string;
  };
  /** When true, errors during the tool loop are re-thrown instead of caught.
   *  Use for workflow tasks where a failed turn should mark the task as failed. */
  readonly throwOnError?: boolean;
}

export interface SessionAgentTurnResult {
  readonly failoverMeta: SessionToolLoopFailoverState | undefined;
  readonly latestAssistantText: string;
  /** Outbound attachments extracted from `show` tool results in this turn. */
  readonly showAttachments?: readonly OutboundAttachment[];
}

function sessionCreds(uid?: number, gid?: number): AgentCredentials {
  const u = uid ?? process.getuid?.() ?? 0;
  const g = gid ?? process.getgid?.() ?? 0;
  return { uid: u, gid: g };
}

const IMAGE_CODEC_PROVIDER_KINDS = new Set(["openai-compatible", "anthropic-messages", "gemini"]);

/**
 * Resolve the image block codec for the first provider in the models config.
 * Returns undefined when the provider kind is not one of the three supported kinds.
 */
function resolveImageBlockCodec(
  modelsConfig: ShoggothModelsConfig | undefined,
  primaryProviderId?: string,
): ImageBlockCodec | undefined {
  if (!modelsConfig?.providers?.length) return undefined;
  // When a primary provider id is given (from session model ref), try it first.
  if (primaryProviderId) {
    const provider = modelsConfig.providers.find((p) => p.id === primaryProviderId);
    if (provider && IMAGE_CODEC_PROVIDER_KINDS.has(provider.kind)) {
      return getImageBlockCodec(
        provider.kind as "openai-compatible" | "anthropic-messages" | "gemini",
      );
    }
  }
  const chain = modelsConfig.failoverChain;
  if (chain?.length) {
    const entry = chain[0];
    const firstProviderId =
      typeof entry === "string"
        ? entry.split("/")[0]
        : (entry as { providerId: string }).providerId;
    const provider = modelsConfig.providers.find((p) => p.id === firstProviderId);
    if (provider && IMAGE_CODEC_PROVIDER_KINDS.has(provider.kind)) {
      return getImageBlockCodec(
        provider.kind as "openai-compatible" | "anthropic-messages" | "gemini",
      );
    }
    return undefined;
  }
  // No failover chain — use the first provider's kind directly.
  const first = modelsConfig.providers[0];
  if (first && IMAGE_CODEC_PROVIDER_KINDS.has(first.kind)) {
    return getImageBlockCodec(first.kind as "openai-compatible" | "anthropic-messages" | "gemini");
  }
  return undefined;
}

// Module-level registry — handlers are stateless; all per-invocation state
// flows through BuiltinToolContext.
const builtinRegistry = new BuiltinToolRegistry();
registerAllBuiltinHandlers(builtinRegistry);

/**
 * Query transcript rows added during this turn (seq > seqBefore) and extract
 * outbound attachments from `show` tool results.
 */
async function extractTurnShowAttachments(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
  seqBefore: number,
  ctx: { workspacePath: string; creds: AgentCredentials },
): Promise<OutboundAttachment[]> {
  const tr = createTranscriptStore(db);
  const page = tr.listPage({
    sessionId,
    contextSegmentId,
    afterSeq: seqBefore,
    limit: 500,
  });
  return extractShowBlocks(page.messages, ctx);
}

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

  const loopImpl = input.loopImpl ?? runToolLoop;
  const ctxSeg = input.session.contextSegmentId.trim();
  if (!ctxSeg) {
    throw new Error("executeSessionAgentTurn: session.contextSegmentId must be non-empty");
  }

  const sessionToken = input.session.systemContextToken;
  const sanitizedUserContent = stripFalsifiedSystemContext(input.userContent, sessionToken);

  const effectiveContent = input.systemContext
    ? wrapWithSystemContext(
        sanitizedUserContent,
        input.systemContext,
        sessionToken ??
          (() => {
            throw new Error("systemContextToken is required when systemContext is provided");
          })(),
      )
    : sanitizedUserContent;

  // --- Tool discovery: evaluate trigger phrases before MCP context resolution ---
  const discoveryConfig = resolveToolDiscoveryConfig(input.config, input.sessionId);
  if (discoveryConfig.enabled) {
    evaluateTriggers(input.config, input.sessionId, effectiveContent, input.db);
  }

  if (!input.minimalContext) {
    input.transcript.append({
      sessionId: input.sessionId,
      contextSegmentId: ctxSeg,
      role: "user",
      content: effectiveContent,
      metadata: input.userMetadata ?? {},
      systemContext: input.systemContext,
    });
  }

  // Record current max seq so we can extract show blocks from this turn only.
  const seqBefore = (
    input.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM transcript_messages WHERE session_id = ?`)
      .get(input.sessionId) as { n: number }
  ).n;

  const history = loadSessionTranscriptAsModelChat(input.db, input.sessionId, ctxSeg);
  let effectiveHistory: ChatMessage[];
  if (input.minimalContext) {
    const tail =
      input.minimalContext.tailMessages > 0
        ? history.slice(-input.minimalContext.tailMessages)
        : [];
    const eventMessage: ChatMessage = {
      role: "user",
      content: input.minimalContext.eventContext,
    };
    effectiveHistory = [...tail, eventMessage];
  } else {
    effectiveHistory = history;
  }

  log.debug("resolving mcp context", { sessionId: input.sessionId });
  let mcpCtx = await input.resolveMcpContext(input.sessionId);
  log.debug("mcp context resolved", {
    sessionId: input.sessionId,
    toolCount: mcpCtx.toolsLoop.length,
  });

  const createToolClient =
    input.createToolCallingClient ?? createFailoverToolCallingClientFromModelsConfig;
  let modelsForSession =
    resolveEffectiveModelsConfig(input.config, input.sessionId) ?? input.config.models;

  // If the session's modelSelection specifies a valid "providerId/model" ref, prepend it
  // to the failover chain so it becomes the primary while keeping failover intact.
  // This is how subagentModel config and session_model op take effect.
  const sessionModelRef = getSessionPrimaryModelRef(input.session.modelSelection);
  if (sessionModelRef && modelsForSession) {
    const existingChain = modelsForSession.failoverChain ?? [];
    const filtered = existingChain.filter((e) => e !== sessionModelRef);
    modelsForSession = {
      ...modelsForSession,
      failoverChain: [sessionModelRef, ...filtered],
    };
  }

  const toolClient = createToolClient(modelsForSession, {
    env: input.env,
    hooks: {
      onProviderExhausted(providerId, error, nextRef) {
        log.warn("model provider failover", {
          sessionId: input.sessionId,
          failedProviderId: providerId,
          error,
          nextRef,
          isSubagent: isSubagentSessionUrn(input.sessionId),
        });
      },
    },
  });

  const modelInvocation = mergeModelInvocationParams(
    modelsForSession,
    input.session.modelSelection,
  );

  const sessionPrimaryProviderId = sessionModelRef
    ? sessionModelRef.slice(0, sessionModelRef.indexOf("/"))
    : undefined;
  const imageBlockCodec = resolveImageBlockCodec(modelsForSession, sessionPrimaryProviderId);

  const effectiveModel =
    sessionModelRef ?? resolveModel(input.db, input.config, { sessionId: input.sessionId })?.ref;

  // --- System Prompt Assembly ---
  const buffered = drainSystemContext(input.sessionId);
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const datePart = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const timePart = now.toISOString().slice(11, 19);
  const systemTimestamp = `Current date and time: ${weekday}, ${datePart} - ${timePart}+00:00 (UTC)`;

  const modelSlashIdx = effectiveModel?.indexOf("/");
  const modelLabel =
    effectiveModel && modelSlashIdx !== undefined && modelSlashIdx > 0
      ? `${effectiveModel.slice(modelSlashIdx + 1)} (provider: ${effectiveModel.slice(0, modelSlashIdx)})`
      : "gemini-flash-latest (provider: google)";

  const assembledSystemPrompt = buildSessionSystemContext({
    workspacePath: input.session.workspacePath,
    workingDirectory: input.session.workingDirectory,
    config: input.config,
    env: input.env,
    sessionId: input.sessionId,
    contextSegmentId: ctxSeg,
    contextLevel: input.session.contextLevel,
    channel: parseAgentSessionUrn(input.sessionId)?.platform ?? "unknown",
    systemContextToken: input.session.systemContextToken!,
    // TODO: wire messagingCapabilities if available
    toolNames: mcpCtx.toolsOpenAi.map((t) => t.function.name),
    sandbox: {
      runtimeUid: input.session.runtimeUid,
      runtimeGid: input.session.runtimeGid,
    },
    stateDb: input.db,
    modelLabel,
    transcriptMessages: input.db
      .prepare(
        `SELECT role, content FROM transcript_messages WHERE session_id = ? AND context_segment_id = ? ORDER BY seq`,
      )
      .all(input.sessionId, ctxSeg) as { role: string; content: string | null }[],
  });

  const baseSystemPrompt =
    buffered.length > 0
      ? assembledSystemPrompt + "\n\n" + buffered.join("\n")
      : assembledSystemPrompt;
  const effectiveSystemPrompt = `${systemTimestamp}\n\n${baseSystemPrompt}`;

  const system: ChatMessage = {
    role: "system",
    content: effectiveSystemPrompt,
  };

  // Strip image blocks from transcript when the provider doesn't support image input.
  const initialMessages: ChatMessage[] = sanitizeTranscriptForProvider(
    [system, ...effectiveHistory],
    imageBlockCodec,
  );

  // --- Mutable tools ref for mid-loop refresh (tool discovery) ---
  let currentToolsOpenAi: readonly OpenAIToolFunctionDefinition[] = mcpCtx.toolsOpenAi;

  let ctxWindowTokens: number | undefined;
  if (!input.minimalContext) {
    if (sessionModelRef) {
      const slashIdx = sessionModelRef.indexOf("/");
      const primaryProviderId = sessionModelRef.slice(0, slashIdx);
      const primaryModelName = sessionModelRef.slice(slashIdx + 1);
      ctxWindowTokens = getModelContextWindowTokens(primaryProviderId, primaryModelName);
    } else {
      ctxWindowTokens = resolveModel(input.db, input.config, {
        sessionId: input.sessionId,
      })?.model?.contextWindowTokens;
    }
  }

  const { signal: turnAbortSignal, end: endTurnAbortScope } = beginSessionTurnAbortScope(
    input.sessionId,
  );

  const model: SessionToolLoopModelClient = createSessionToolLoopModelClient({
    toolClient,
    initialMessages,
    tools: () => currentToolsOpenAi,
    modelInvocation,
    streamModel: Boolean(input.stream?.streamModel),
    onModelTextDelta: input.stream?.onModelTextDelta,
    onUsageDelta: (delta) => {
      incrementTokenUsage(input.db, input.sessionId, delta);
    },
    compaction: ctxWindowTokens
      ? {
          db: input.db,
          sessionId: input.sessionId,
          contextSegmentId: ctxSeg,
          ctxWindowTokens,
          reserveTokens: modelsForSession?.compaction?.contextWindowReserveTokens ?? 20_000,
          modelsConfig: modelsForSession,
          compactionModel: modelsForSession?.compaction?.model,
          env: input.env,
          systemPromptChars: effectiveSystemPrompt.length,
          toolSchemaChars: JSON.stringify(currentToolsOpenAi).length,
          turnAbortSignal,
          compactionAbortTimeoutMs:
            modelsForSession?.compaction?.compactionAbortTimeoutMs ?? 60_000,
        }
      : undefined,
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
    aggregated: mcpCtx.fullAggregated ?? mcpCtx.aggregated,
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
          workingDirectory: input.session.workingDirectory ?? undefined,
          creds,
          orchestratorEnv,
          getAgentIntegrationInvoker,
          getProcessManager,
          messageToolCtx: messageToolContextRef.current ?? undefined,
          memoryConfig: resolveEffectiveMemoryForSession(input.config, input.sessionId),
          runtimeOpenaiBaseUrl: input.config.runtime?.openaiBaseUrl,
          isSubagentSession: isSubagentSessionUrn(input.sessionId),
          imageBlockCodec,
        };
        if (builtinRegistry.has(originalName)) {
          return builtinRegistry.execute(originalName, args, toolCtx);
        }
        // Preserve the original error for unrecognised session.* names
        if (originalName.startsWith("session-")) {
          return {
            resultJson: JSON.stringify({
              error: `unknown integration builtin: ${originalName}`,
            }),
          };
        }
        return {
          resultJson: JSON.stringify({
            error: `unknown builtin: ${originalName}`,
          }),
        };
      } catch (e) {
        return { resultJson: JSON.stringify({ error: String(e) }) };
      }
    },
  });

  log.debug("model call started", {
    sessionId: input.sessionId,
    messageCount: initialMessages.length,
    toolCount: mcpCtx.toolsLoop.length,
    systemPromptLen: effectiveSystemPrompt.length,
    totalContentLen: initialMessages.reduce((n, m) => n + (m.content?.length ?? 0), 0),
    model: effectiveModel ? `default (${effectiveModel})` : "default",
    isSubagent: isSubagentSessionUrn(input.sessionId),
  });
  log.debug("user message", {
    sessionId: input.sessionId,
    userContent: effectiveContent,
    systemContext: input.systemContext ?? null,
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
      toolCallTimeoutMs: resolveToolCallTimeoutMs(input.config, input.sessionId),
      onStatsUpdate: (update) => {
        if (update.estimatedInputTokens) {
          incrementTokenUsage(input.db, input.sessionId, {
            inputTokens: update.estimatedInputTokens,
            outputTokens: 0,
          });
        }
        if (update.transcriptMessageCount != null) {
          updateTranscriptMessageCount(input.db, input.sessionId, update.transcriptMessageCount);
        }
      },
      // --- Mid-loop tool refresh for tool discovery ---
      refreshTools: discoveryConfig.enabled
        ? () => {
            // Synchronously re-resolve: the finalizer reads updated session_tool_state
            // We can't await here, but the finalizer pipeline is sync (DB reads only).
            // Re-run the finalizer chain by calling resolveMcpContext would be async,
            // so instead we import and call the finalizer directly.
            // For now, re-resolve via the same async path isn't possible in the sync callback.
            // The tool loop will pick up changes on the next turn if we can't refresh synchronously.
            // However, the discovery finalizer IS synchronous (just DB reads), so we can
            // build a lightweight refresh here.

            const baseMcpCtx = mcpCtx.fullAggregated
              ? { ...mcpCtx, aggregated: mcpCtx.fullAggregated }
              : mcpCtx;
            const finalizer = createToolDiscoveryFinalizer(input.config, input.db);
            const refreshed = finalizer(baseMcpCtx, input.sessionId);
            currentToolsOpenAi = refreshed.toolsOpenAi;
            mcpCtx = refreshed;
            return refreshed.toolsLoop;
          }
        : undefined,
    });
  } catch (e) {
    if (e instanceof TurnAbortedError) {
      pushSystemContext(input.sessionId, "Previous turn was aborted. Results may be partial.");
      // Workflow tasks opt into throwOnError so the orchestrator can mark the task as failed.
      if (input.throwOnError) throw e;
      const failoverMeta = model.getSessionToolLoopFailoverState();
      const latestAssistantText =
        (extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "") +
        "\n\n<Aborted>";
      return { failoverMeta, latestAssistantText };
    }
    // Catch-all: log the error and return whatever partial response exists
    // rather than killing the turn entirely.
    const errMsg = e instanceof Error ? e.message : String(e);
    const bodySnippet = e instanceof ModelHttpError ? e.bodySnippet : undefined;
    log.error("tool loop unexpected error", {
      sessionId: input.sessionId,
      error: errMsg,
      ...(bodySnippet ? { bodySnippet } : {}),
    });

    // Workflow tasks opt into throwOnError so the orchestrator can mark the task as failed.
    if (input.throwOnError) throw e;

    pushSystemContext(input.sessionId, `Previous turn encountered an error: ${errMsg}`);
    const failoverMeta2 = model.getSessionToolLoopFailoverState();
    const latestAssistantText2 =
      extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ??
      `_Turn failed: ${errMsg}_`;
    return {
      failoverMeta: failoverMeta2,
      latestAssistantText: latestAssistantText2,
    };
  } finally {
    endTurnAbortScope();
  }

  const failoverMeta = model.getSessionToolLoopFailoverState();
  const latestAssistantText =
    extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "_No reply text._";

  log.debug("model response received", {
    sessionId: input.sessionId,
    model: failoverMeta ? `${failoverMeta.usedProviderId}/${failoverMeta.usedModel}` : null,
    contentLength: latestAssistantText.length,
    degraded: failoverMeta?.degraded,
  });
  log.debug("agent response content", {
    sessionId: input.sessionId,
    response: latestAssistantText,
  });

  // --- Session stats: record completed agent turn (tokens already written incrementally) ---
  const accumulatedUsage = model.getAccumulatedUsage();

  // Fall back to metadata store for context window if provider didn't report it
  let contextWindowTokens = accumulatedUsage?.contextWindowTokens;
  if (contextWindowTokens == null && failoverMeta) {
    contextWindowTokens = getModelContextWindowTokens(
      failoverMeta.usedProviderId,
      failoverMeta.usedModel ?? "",
    );
    if (contextWindowTokens != null) {
      incrementTokenUsage(input.db, input.sessionId, {
        inputTokens: 0,
        outputTokens: 0,
        contextWindowTokens,
      });
    }
  }

  incrementTurnCount(input.db, input.sessionId);

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

  // --- Extract show tool attachments from this turn ---
  const showAttachments = await extractTurnShowAttachments(
    input.db,
    input.sessionId,
    ctxSeg,
    seqBefore,
    { workspacePath: input.session.workspacePath, creds },
  );

  return {
    failoverMeta,
    latestAssistantText,
    showAttachments: showAttachments.length > 0 ? showAttachments : undefined,
  };
}

/**
 * Export the builtin tool registry for use by workflow tool executor.
 */
export function getBuiltinToolRegistry(): BuiltinToolRegistry {
  return builtinRegistry;
}
