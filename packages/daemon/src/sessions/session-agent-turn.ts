import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import { modelProvidersToEntries, parseAgentSessionUrn } from "@shoggoth/shared";
import { buildSessionSystemContext } from "./session-system-prompt";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type {
  ChatMessage,
  ImageBlockCodec,
  ModelInvocationParams,
  OpenAIToolFunctionDefinition,
} from "@shoggoth/models";
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
import { vaultServiceRef } from "../vault/vault-ref";
import { serviceToolRegistryRef } from "./service-tool-registry-ref";
import { registerAllBuiltinHandlers } from "./builtin-handlers/index";
import { createMcpRoutingToolExecutor } from "../mcp/tool-loop-mcp";
import { createSystemGates } from "./system-gates";
import { createToolLoopPolicyAndAudit } from "../policy/tool-loop-bridge";
import { createDefaultSubResourceRegistry } from "../policy/sub-resource";
import {
  runToolLoop,
  type RunToolLoopHitl,
  type RunToolLoopOptions,
  type ToolCallEvent,
  type ToolLoopResult,
} from "./tool-loop";
import type { TranscriptStore } from "./transcript-store";
import type { ToolRunStore } from "./tool-run-store";
import type { SessionRow } from "./session-store";
import {
  extractLatestTranscriptAssistantText,
  extractTurnTranscriptAssistantProse,
  loadSessionTranscriptAsModelChat,
  sanitizeTranscriptForProvider,
} from "./transcript-to-chat";
import {
  createSessionToolLoopModelClient,
  type ModelRoundEndEvent,
  type ModelTextStreamEvent,
  type ModelThinkingDeltaEvent,
  type SessionToolLoopFailoverState,
  type SessionToolLoopModelClient,
} from "./session-tool-loop-model-client";
import type { SessionMcpToolContext } from "./session-mcp-tool-context";
import type { PolicyEngine } from "../policy/engine";
import {
  beginSessionTurnAbortScope,
  notifyOnTurnAbort,
  TurnAbortedError,
} from "./session-turn-abort";
import { messageToolContextRef } from "../messaging/message-tool-context-ref";
import {
  incrementTokenUsage,
  updateTranscriptMessageCount,
  incrementTurnCount,
} from "./session-stats-store";
import { resolveAgentCreds } from "../agent-creds";
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
  readonly loopImpl?: (opts: RunToolLoopOptions) => Promise<ToolLoopResult>;
  readonly createToolCallingClient?: (
    models: ShoggothConfig["models"],
    options?: CreateFailoverFromConfigOptions,
  ) => FailoverToolCallingClient;
  readonly resolveMcpContext: (sessionId: string) => Promise<SessionMcpToolContext>;
  readonly stream?: {
    readonly streamModel: boolean;
    /** The current round's prose stream (per-round, not glued to prior rounds). */
    readonly onModelTextDelta?: (ev: ModelTextStreamEvent) => void | Promise<void>;
    /** A round settled: its authoritative final prose content for display. */
    readonly onModelRoundEnd?: (ev: ModelRoundEndEvent) => void;
  };
  /** When set, this is a minimal context turn — truncate transcript to tail messages. */
  readonly minimalContext?: {
    readonly tailMessages: number;
    readonly eventContext: string;
  };
  /** When true, errors during the tool loop are re-thrown instead of caught.
   *  Use for workflow tasks where a failed turn should mark the task as failed. */
  readonly throwOnError?: boolean;
  /** Optional override merged into the session's model invocation params before the turn. */
  readonly modelInvocationOverride?: Partial<ModelInvocationParams>;
  /** Optional turn lifecycle events for the status bar / external observers. */
  readonly events?: {
    /** Reasoning/thinking content is streaming from the model. */
    readonly onThinkingDelta?: (ev: ModelThinkingDeltaEvent) => void;
    readonly onToolCall?: (ev: ToolCallEvent) => void;
    /** A HITL approval row was queued for a tool call (⏸️). */
    readonly onHitlQueued?: (call: { name: string; argsJson: string }) => void;
    /** A mid-turn compaction completed. */
    readonly onCompaction?: () => void;
    /** A model call reported provider usage: the call's input tokens are the
     *  best mid-turn gauge of current context-window fill. */
    readonly onContextUpdate?: (update: {
      readonly currentTokens: number;
      readonly totalTokens?: number;
    }) => void;
    /** A subagent spawn succeeded mid-turn: fresh active counts (live bar). */
    readonly onSubagentsChanged?: (counts: {
      readonly total: number;
      readonly persistent: number;
    }) => void;
    /** A timer was queued or cancelled mid-turn: fresh unfired count (live bar). */
    readonly onTimersChanged?: (count: number) => void;
    /** An exec-notify handle was registered or resolved mid-turn: fresh live
     *  handle count (live bar). */
    readonly onNotifiesChanged?: (count: number) => void;
    /** The turn's abort scope was aborted (operator `session_abort`, subagent
     *  kill, …). Fires even when the aborted model call never settles, so
     *  presentation pipelines (stream pushers, status bars) can stop
     *  producing output immediately instead of waiting for post-turn
     *  delivery that may never run. */
    readonly onTurnAborted?: () => void;
  };
}

export interface SessionAgentTurnResult {
  readonly failoverMeta: SessionToolLoopFailoverState | undefined;
  readonly latestAssistantText: string;
  /** Every assistant text segment of THIS turn, concatenated in order
   *  (pre-tools and post-tools prose, including prose emitted alongside a
   *  tool-call round). Undefined when the turn produced no prose (tool-only
   *  turns) — and on aborted/failed turns — so non-streaming delivery can
   *  fall back to `latestAssistantText`. */
  readonly assistantTurnProse?: string;
  /** Cancellation is separate from partial text, which may itself be valid JSON. */
  readonly aborted?: boolean;
  /** Outbound attachments extracted from `show` tool results in this turn. */
  readonly showAttachments?: readonly OutboundAttachment[];
  /** Maps to 🛑/❌/✅ in the status bar; "canceled" is the runaway breaker's cancel. */
  readonly outcome: "completed" | "aborted" | "failed" | "canceled";
  /** Rendered terminal status-bar line (✅/🛑/❌), set only by the OOB banner
   *  internal-delivery path when a tracker existed, so the banner's final
   *  edit can carry the bar. Undefined on messaging_surface and inbound turns. */
  readonly statusBarLine?: string;
}

/**
 * Effective runtime credentials for a session row: the row's stamped uid/gid
 * when present, otherwise the configured agent credentials. Shared with the
 * contract engine so contract git runs under the same identity as the
 * session's own exec calls.
 */
export function sessionCreds(uid?: number, gid?: number): AgentCredentials {
  const defaults = resolveAgentCreds();
  const u = uid ?? defaults.uid;
  const g = gid ?? defaults.gid;
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
  const providers = modelsConfig?.providers
    ? modelProvidersToEntries(modelsConfig.providers)
    : undefined;
  if (!providers?.length) return undefined;
  // When a primary provider id is given (from session model ref), try it first.
  if (primaryProviderId) {
    const provider = providers.find((p) => p.id === primaryProviderId);
    if (provider && IMAGE_CODEC_PROVIDER_KINDS.has(provider.kind)) {
      return getImageBlockCodec(
        provider.kind as "openai-compatible" | "anthropic-messages" | "gemini",
      );
    }
  }
  const chain = modelsConfig?.failoverChain;
  if (chain?.length) {
    const entry = chain[0];
    const firstProviderId =
      typeof entry === "string"
        ? entry.split("/")[0]
        : (entry as { providerId: string }).providerId;
    const provider = providers.find((p) => p.id === firstProviderId);
    if (provider && IMAGE_CODEC_PROVIDER_KINDS.has(provider.kind)) {
      return getImageBlockCodec(
        provider.kind as "openai-compatible" | "anthropic-messages" | "gemini",
      );
    }
    return undefined;
  }
  // No failover chain — use the first provider's kind directly.
  const first = providers[0];
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
  const baseModels =
    resolveEffectiveModelsConfig(input.config, input.sessionId) ?? input.config.models;

  // Snapshot of everything the turn resolved from the current model selection:
  // failover chain (with the session's model prepended), tool client, merged
  // invocation params, context window, and image block codec. Re-resolved on
  // every tool-loop round so a session_model switch mid-turn takes effect on
  // the NEXT round (next tool call / generation), not only on the next turn.
  interface TurnModelResolution {
    readonly models: ShoggothModelsConfig | undefined;
    readonly modelRef: string | undefined;
    readonly toolClient: FailoverToolCallingClient;
    readonly modelInvocation: ModelInvocationParams;
    readonly ctxWindowTokens: number | undefined;
    readonly imageBlockCodec: ImageBlockCodec | undefined;
    /** Raw `model_selection_json` the snapshot was resolved from (change detection). */
    readonly selectionJson: string | null;
  }

  // Re-read the session row: the session_model op updates it mid-turn, and
  // every round must observe the latest selection (failover chain, tool
  // client, invocation params, and context window are all derived from it).
  const readLatestModelSelection = (): { selection: unknown; json: string | null } => {
    const latestRow = input.db
      .prepare(`SELECT model_selection_json FROM sessions WHERE id = ?`)
      .get(input.sessionId) as { model_selection_json: string | null } | undefined;
    if (!latestRow) return { selection: input.session.modelSelection, json: null };
    const json = latestRow.model_selection_json;
    if (json == null) return { selection: undefined, json: null };
    try {
      return { selection: JSON.parse(json), json };
    } catch {
      // Unreadable JSON: keep the turn-start selection, but still track the
      // raw value so an equivalent re-write is not treated as a switch.
      return { selection: input.session.modelSelection, json };
    }
  };

  const resolveTurnModel = (
    modelSelection: unknown,
    selectionJson: string | null,
  ): TurnModelResolution => {
    let models = baseModels;
    // If the modelSelection specifies a valid "providerId/model" ref, prepend it
    // to the failover chain so it becomes the primary while keeping failover intact.
    // This is how subagentModel config and session_model op take effect.
    const modelRef = getSessionPrimaryModelRef(modelSelection);
    if (modelRef && models) {
      const existingChain = models.failoverChain ?? [];
      const filtered = existingChain.filter((e) => e !== modelRef);
      models = {
        ...models,
        failoverChain: [modelRef, ...filtered],
      };
    }

    const toolClient = createToolClient(models, {
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

    const baseInvocation = mergeModelInvocationParams(models, modelSelection);
    const modelInvocation = input.modelInvocationOverride
      ? { ...baseInvocation, ...input.modelInvocationOverride }
      : baseInvocation;

    const modelProviderId = modelRef ? modelRef.slice(0, modelRef.indexOf("/")) : undefined;
    const imageBlockCodec = resolveImageBlockCodec(models, modelProviderId);

    let ctxWindowTokens: number | undefined;
    if (!input.minimalContext) {
      if (modelRef) {
        const slashIdx = modelRef.indexOf("/");
        ctxWindowTokens = getModelContextWindowTokens(
          modelRef.slice(0, slashIdx),
          modelRef.slice(slashIdx + 1),
        );
      } else {
        ctxWindowTokens = resolveModel(input.db, input.config, {
          sessionId: input.sessionId,
        })?.model?.contextWindowTokens;
      }
      if (!ctxWindowTokens) {
        // Without a window there is no mid-turn compaction threshold, so the
        // check stays off for the whole turn — make that visible instead of
        // silently degrading.
        log.warn(
          "mid-turn compaction disabled for this turn: context window could not be resolved",
          {
            sessionId: input.sessionId,
            modelRef: modelRef ?? null,
          },
        );
      }
    }

    return {
      models,
      modelRef,
      toolClient,
      modelInvocation,
      ctxWindowTokens,
      imageBlockCodec,
      selectionJson,
    };
  };

  const initialSelection = readLatestModelSelection();
  let turnModel = resolveTurnModel(initialSelection.selection, initialSelection.json);
  let modelsForSession = turnModel.models;
  let sessionModelRef = turnModel.modelRef;
  let toolClient = turnModel.toolClient;
  let modelInvocation = turnModel.modelInvocation;
  let ctxWindowTokens = turnModel.ctxWindowTokens;
  let imageBlockCodec = turnModel.imageBlockCodec;
  const effectiveModel =
    sessionModelRef ?? resolveModel(input.db, input.config, { sessionId: input.sessionId })?.ref;

  // Called by the round-dynamic tool client wrapper before every round:
  // re-resolve the model snapshot so a mid-turn session_model switch lands on
  // the very next round, and return true when a NEW snapshot was installed.
  const refreshTurnModelForRound = (): boolean => {
    const latest = readLatestModelSelection();
    // Nothing changed since the current snapshot: keep it (stable identity
    // for reference equality checks downstream).
    if (latest.json === turnModel.selectionJson) return false;
    const fresh = resolveTurnModel(latest.selection, latest.json);
    if (fresh.modelRef === sessionModelRef) {
      // Invocation-only tweak (same model ref): refresh just the invocation
      // params so the tool client and context window stay stable.
      modelInvocation = fresh.modelInvocation;
      turnModel = { ...turnModel, modelInvocation, selectionJson: fresh.selectionJson };
      return true;
    }
    // Full model switch: swap failover chain, tool client, invocation params,
    // context window / compaction config, and image block codec.
    turnModel = fresh;
    modelsForSession = fresh.models;
    sessionModelRef = fresh.modelRef;
    toolClient = fresh.toolClient;
    modelInvocation = fresh.modelInvocation;
    ctxWindowTokens = fresh.ctxWindowTokens;
    if (fresh.imageBlockCodec) imageBlockCodec = fresh.imageBlockCodec;
    return true;
  };

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
      : "default";

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

  const { signal: turnAbortSignal, end: endTurnAbortScope } = beginSessionTurnAbortScope(
    input.sessionId,
  );
  // Notify the presentation pipeline the moment the turn is aborted. Cleanup
  // that runs only when the turn promise settles is not enough: an aborted
  // model call can hang forever (e.g. a stuck provider streaming deltas),
  // leaving stream pushers/status bars editing a dead message indefinitely.
  // notifyOnTurnAbort also covers an ALREADY-aborted signal (the abort raced
  // turn setup against a slow provider): a bare addEventListener would never
  // fire and the display pipeline would outlive the session.
  const notifyTurnAborted = () => input.events?.onTurnAborted?.();
  notifyOnTurnAbort(turnAbortSignal, notifyTurnAborted);

  // The tool loop calls this client once per round. Re-resolving INSIDE the
  // wrapper (rather than at loop construction) is what makes a mid-turn
  // session_model switch land on the very next round: every round's
  // completeWithTools first re-reads the session's model selection and swaps
  // the whole snapshot (failover chain, tool client, invocation params,
  // context window / compaction config), then delegates to the current client.
  const roundDynamicToolClient: FailoverToolCallingClient = {
    get capabilities() {
      return toolClient.capabilities;
    },
    async completeWithTools(req) {
      refreshTurnModelForRound();
      return toolClient.completeWithTools(req);
    },
  };

  const model: SessionToolLoopModelClient = createSessionToolLoopModelClient({
    toolClient: roundDynamicToolClient,
    initialMessages,
    tools: () => currentToolsOpenAi,
    // Getter: every round reads the CURRENT snapshot's invocation params, so
    // an invocation-only update (or a full switch) applies from the next round.
    get modelInvocation() {
      return modelInvocation;
    },
    turnAbortSignal,
    streamModel: Boolean(input.stream?.streamModel),
    onModelTextDelta: input.stream?.onModelTextDelta,
    onModelRoundEnd: input.stream?.onModelRoundEnd,
    onThinkingDelta: input.events?.onThinkingDelta,
    onCompaction: input.events?.onCompaction,
    onUsageDelta: (delta) => {
      // Provider-reported actuals: this call's total input+output is the best
      // available gauge of current context fill once the turn's final message
      // lands in the transcript (it includes system prompt and tool schema
      // overhead that transcript heuristics cannot see).
      incrementTokenUsage(input.db, input.sessionId, {
        ...delta,
        contextFillTokens: delta.inputTokens + delta.outputTokens,
      });
      // Tap the same delta for the live status bar (provider actuals, no DB
      // re-read): the call's input tokens are the best mid-turn gauge of
      // context fill; the window is provider-reported when available, else
      // the turn's resolved model metadata.
      input.events?.onContextUpdate?.({
        currentTokens: delta.inputTokens,
        totalTokens: delta.contextWindowTokens ?? ctxWindowTokens,
      });
    },
    // Getter: rebuilt from the CURRENT snapshot on each round, so a
    // mid-turn switch swaps ctxWindowTokens and the compaction config
    // derived from it (models config, reserve, compaction model, timeout).
    get compaction():
      | NonNullable<Parameters<typeof createSessionToolLoopModelClient>[0]["compaction"]>
      | undefined {
      // This getter is read at the start of each model-client round, before
      // its compaction check, so the new window/config applies immediately.
      refreshTurnModelForRound();
      if (!ctxWindowTokens) return undefined;
      return {
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
        compactionAbortTimeoutMs: modelsForSession?.compaction?.compactionAbortTimeoutMs ?? 60_000,
      };
    },
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

  // Cache the prepared statement for reading working directory from DB.
  // Reused on every tool call within this turn so the statement isn't re-prepared each time.
  const getWorkingDirStmt = input.db.prepare(`SELECT working_directory FROM sessions WHERE id = ?`);

  // Configurable system gates (AGENTS.md discovery / re-read-required) for
  // external tools matching config.gates.*.tools globs. Built once per turn;
  // reads the working directory fresh per tool call so `cd` updates are visible.
  const systemGates = createSystemGates({
    db: input.db,
    sessionId: input.sessionId,
    contextSegmentId: ctxSeg,
    workspacePath: input.session.workspacePath,
    config: input.config,
    getWorkingDirectory: () => {
      const wd = getWorkingDirStmt.get(input.sessionId) as
        | { working_directory: string | null }
        | undefined;
      return wd?.working_directory?.trim() || undefined;
    },
  });

  const executor = createMcpRoutingToolExecutor({
    aggregated: mcpCtx.fullAggregated ?? mcpCtx.aggregated,
    ...(mcpCtx.external ? { external: mcpCtx.external } : {}),
    // Mid-turn lapse recovery: if the pooled MCP session was closed under this
    // turn (e.g. 30-minute idle eviction — see tool-loop-mcp), re-resolve the
    // context so `external` dispatches against a freshly reconnected pool, then
    // retry the call once. Reassigning `mcpCtx` keeps refreshTools (below) and
    // the executor's retry reading from the same refreshed context.
    reconnectExternal: async () => {
      mcpCtx = await input.resolveMcpContext(input.sessionId);
      return mcpCtx.external;
    },
    builtin: async ({ originalName, argsJson }) => {
      try {
        const args = JSON.parse(argsJson) as Record<string, unknown>;
        const toolCtx: BuiltinToolContext = {
          sessionId: input.sessionId,
          db: input.db,
          config: input.config,
          env: input.env,
          workspacePath: input.session.workspacePath,
          workspaceRealPath: realpathSync(input.session.workspacePath),
          workingDirectory: (() => {
            // Read workingDirectory fresh from DB on each tool call so that
            // `cd` updates within the same turn are visible to subsequent tools.
            const wd = getWorkingDirStmt.get(input.sessionId) as
              | { working_directory: string | null }
              | undefined;
            return wd?.working_directory?.trim() || undefined;
          })(),
          creds,
          orchestratorEnv,
          getAgentIntegrationInvoker,
          getProcessManager,
          messageToolCtx: messageToolContextRef.current ?? undefined,
          memoryConfig: resolveEffectiveMemoryForSession(input.config, input.sessionId),
          runtimeOpenaiBaseUrl: input.config.runtime?.openaiBaseUrl,
          isSubagentSession: isSubagentSessionUrn(input.sessionId),
          onSubagentsChanged: input.events?.onSubagentsChanged,
          onTimersChanged: input.events?.onTimersChanged,
          onNotifiesChanged: input.events?.onNotifiesChanged,
          imageBlockCodec,
          vault: vaultServiceRef.current,
        };
        if (builtinRegistry.has(originalName)) {
          return builtinRegistry.execute(originalName, args, toolCtx);
        }
        // Service tool dispatch (plugin services)
        const svcRegistry = serviceToolRegistryRef.current;
        if (svcRegistry?.get(originalName)) {
          return svcRegistry.invokeTool(originalName, args, {
            agentId: parseAgentSessionUrn(input.sessionId)?.agentId ?? "unknown",
            sessionUrn: input.sessionId,
          });
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
  let loopResult: ToolLoopResult | undefined;
  try {
    loopResult = await loopImpl({
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
      systemGates,
      hitl: {
        ...input.hitl,
        config: input.getHitlConfig(),
        // Wrap the inbound afterHitlQueued so the status bar tracker learns
        // about queued approvals (pause) even when no platform notice is configured.
        afterHitlQueued: (row) => {
          const payload = row.payload as { argsJson?: string } | undefined;
          input.events?.onHitlQueued?.({
            name: row.toolName,
            argsJson: payload?.argsJson ?? "",
          });
          return input.hitl.afterHitlQueued?.(row);
        },
      },
      onToolCallEvent: input.events?.onToolCall,
      toolCallTimeoutMs: resolveToolCallTimeoutMs(input.config, input.sessionId),
      maxToolsPerBatch: input.config.agents?.maxToolsPerBatch ?? 10,
      onStatsUpdate: (update) => {
        // `estimatedInputTokens` (char heuristics for tool args/results) is
        // intentionally NOT added to session_stats.input_tokens: tool content
        // is billed inside the next model call's provider-reported prompt
        // tokens, so persisting estimates here would double-count against
        // provider actuals.
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
      const primaryModel = modelsForSession?.failoverChain?.[0];
      const latestAssistantText =
        (extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "") +
        "\n\n<Aborted>";
      return {
        failoverMeta: failoverMeta ? { ...failoverMeta, primaryModel } : undefined,
        latestAssistantText,
        // Dual contract: `outcome` feeds the turn status tracker; the legacy
        // `aborted` flag is still read by the OOB delivery machinery to skip
        // structured-output repair on cancelled turns.
        outcome: "aborted",
        aborted: true,
      };
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
    const primaryModel2 = modelsForSession?.failoverChain?.[0];
    const latestAssistantText2 =
      extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ??
      `_Turn failed: ${errMsg}_`;
    return {
      failoverMeta: failoverMeta2 ? { ...failoverMeta2, primaryModel: primaryModel2 } : undefined,
      latestAssistantText: latestAssistantText2,
      outcome: "failed",
    };
  } finally {
    // With { once: true } this is a no-op after an abort fired; it cleans up
    // the listener on the normal (never-aborted) path.
    turnAbortSignal.removeEventListener("abort", notifyTurnAborted);
    endTurnAbortScope();
  }

  const failoverMeta = model.getSessionToolLoopFailoverState();
  const effectivePrimaryModel = modelsForSession?.failoverChain?.[0];
  const latestAssistantText =
    extractLatestTranscriptAssistantText(input.db, input.sessionId, ctxSeg) ?? "_No reply text._";

  log.debug("model response received", {
    sessionId: input.sessionId,
    model: failoverMeta ? `${failoverMeta.usedProviderId}/${failoverMeta.usedModel}` : null,
    contentLength: latestAssistantText.length,
    degraded: failoverMeta?.degraded,
    // Provider stop reason for the final hop; `length` = output-token truncation.
    finishReason: model.getLastFinishReason() ?? null,
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

  // Full prose of THIS turn: every assistant segment written since seqBefore,
  // in order (tool-call rounds included — their pre-tools prose rides the
  // same row). Non-streaming delivery paths compose their body from this so
  // prose → tools → prose turns deliver ALL segments, not only the last one
  // `latestAssistantText` carries.
  const assistantTurnProse = extractTurnTranscriptAssistantProse(
    input.db,
    input.sessionId,
    ctxSeg,
    seqBefore,
  );

  // --- Extract show tool attachments from this turn ---
  const showAttachments = await extractTurnShowAttachments(
    input.db,
    input.sessionId,
    ctxSeg,
    seqBefore,
    { workspacePath: input.session.workspacePath, creds },
  );

  return {
    failoverMeta: failoverMeta
      ? { ...failoverMeta, primaryModel: effectivePrimaryModel }
      : undefined,
    latestAssistantText,
    assistantTurnProse,
    showAttachments: showAttachments.length > 0 ? showAttachments : undefined,
    outcome: loopResult?.canceledBy === "runaway" ? "canceled" : "completed",
  };
}

export function getBuiltinToolRegistry(): BuiltinToolRegistry {
  return builtinRegistry;
}
