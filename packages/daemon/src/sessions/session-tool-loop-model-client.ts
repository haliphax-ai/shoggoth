import type Database from "better-sqlite3";
import type {
  ChatMessage,
  FailoverToolCallingClient,
  ModelInvocationParams,
  ModelUsage,
  OpenAIToolFunctionDefinition,
} from "@shoggoth/models";
import {
  resolveCompactionPolicyFromModelsConfig,
  createFailoverClientFromModelsConfig,
  ModelRequestAbortedError,
} from "@shoggoth/models";
import {
  modelProvidersToEntries,
  normalizeToolCallArgsJson,
  type ShoggothModelsConfig,
} from "@shoggoth/shared";
import { compactSessionTranscript } from "../transcript-compact";
import { loadSessionTranscriptAsModelChat } from "./transcript-to-chat";
import { TurnAbortedError } from "./session-turn-abort";
import { getLogger } from "../logging";
import { estimateTokensFromContent } from "./session-stats-store";
import type { ModelClient } from "./tool-loop";

/** Format a duration in ms as a human-readable string (e.g. "5m", "30s"). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

const log = getLogger("session-tool-loop-model-client");

export interface SessionToolLoopModelClient extends ModelClient {
  /** Best-effort failover metadata from the most recent `completeWithTools` hop. */
  getSessionToolLoopFailoverState(): SessionToolLoopFailoverState | undefined;
  /** Accumulated token usage across all `completeWithTools` calls in this tool loop. */
  getAccumulatedUsage(): ModelUsage | undefined;
  /**
   * Provider-reported finish reason from the most recent `completeWithTools`
   * call (e.g. `stop`, `length`, `tool_calls`). `length` means the response
   * was truncated at the output-token limit.
   */
  getLastFinishReason(): string | undefined;
  /**
   * Runs one compaction pass against the CURRENT compaction config at a
   * caller-chosen logical break in the tool loop (the tool loop parks itself
   * there and freezes the turn queue before calling this). No-ops (compacted:
   * false) when mid-turn compaction is not armed; rethrows compaction
   * failures after firing {@link onCompactionFailed} so callers can report.
   */
  runCompaction(): Promise<{ compacted: boolean; messageCount: number }>;

  /**
   * Runs a threshold-path compaction pass with the configured abort timeout.
   * On a timeout the pass keeps running in the background (its completion
   * still reloads the history), so no failure event fires and the loop
   * continues without waiting; on a real failure the pass is dead and
   * {@link onCompactionFailed} fires.
   */
  runCompactionGuarded(): Promise<void>;
  /**
   * Fires onCompactionBanner with a compaction banner (start / timeout /
   * failure notices) so the banner manager can deliver them mid-turn.
   */
  readonly onCompactionBanner?: (banner: string) => void;
}

export interface SessionToolLoopFailoverState {
  readonly degraded: boolean;
  readonly usedModel: string;
  readonly usedProviderId: string;
  /** The actual primary model tried first (may differ from config's failoverChain[0] when a session model override is active). */
  readonly primaryModel?: string;
}

/** A streaming prose delta scoped to one tool-loop round. */
export interface ModelTextStreamEvent {
  /** The provider's delta chunk. */
  readonly delta: string;
  /** The round's accumulated content so far — never glued to prior rounds. */
  readonly accumulated: string;
  /** Zero-based index of the tool-loop round that produced this delta. */
  readonly round: number;
}

/** A streaming reasoning delta scoped to one tool-loop round. */
export interface ModelThinkingDeltaEvent {
  /** The round's accumulated reasoning so far. */
  readonly accumulated: string;
  /** Zero-based index of the tool-loop round that produced this delta. */
  readonly round: number;
}

/** A settled tool-loop round with its authoritative final prose content. */
export interface ModelRoundEndEvent {
  readonly round: number;
  /** The round's final content as recorded in the transcript (may be blank). */
  readonly content: string;
}

/**
 * Stateful OpenAI-style chat client for `runToolLoop`: keeps `messages`, forwards tool
 * results via `pushToolMessage`, and tracks whether any failover hop was degraded.
 */
export function createSessionToolLoopModelClient(input: {
  readonly toolClient: FailoverToolCallingClient;
  readonly initialMessages: readonly ChatMessage[];
  /**
   * Tool list for each `complete()` call. Accepts a static array (backward-compatible)
   * or a getter function for mid-loop refresh (tool discovery).
   */
  readonly tools:
    | readonly OpenAIToolFunctionDefinition[]
    | (() => readonly OpenAIToolFunctionDefinition[]);
  /** Per-turn parameters forwarded to each `completeWithTools` (merged with stream options). */
  readonly modelInvocation?: ModelInvocationParams;
  /**
   * Turn abort signal forwarded to each `completeWithTools` so an abort
   * cancels the in-flight HTTP request and closes the SSE response stream
   * immediately instead of waiting for it to drain. Abort errors surface as
   * {@link TurnAbortedError}.
   */
  readonly turnAbortSignal?: AbortSignal;
  /**
   * When true, passes `stream: true` to `completeWithTools` (OpenAI SSE). Use with
   * {@link onModelTextDelta} for live display (e.g. streaming edits on a message platform).
   */
  readonly streamModel?: boolean;
  /**
   * Receives the current round's **display** prose stream (per-round
   * accumulated content, never glued to prior rounds). Consumers compose
   * cross-round display from these events plus {@link onModelRoundEnd}.
   * Only invoked when `streamModel` is true.
   */
  readonly onModelTextDelta?: (ev: ModelTextStreamEvent) => void | Promise<void>;
  /**
   * Fires after each `complete()` call with the round's authoritative final
   * prose content, BEFORE the next round's first delta — display consumers
   * use it to settle the round (reconcile any drifted streamed tail) and to
   * place the cross-round separator. Only invoked when `streamModel` is true.
   */
  readonly onModelRoundEnd?: (ev: ModelRoundEndEvent) => void;
  /**
   * Fires after each `complete()` call with the per-call token delta (not accumulated totals).
   * Use for incremental stats persistence so mid-turn queries see up-to-date numbers.
   */
  readonly onUsageDelta?: (delta: ModelUsage) => void;
  /** Reasoning/thinking content is streaming from the model (mapped from onReasoningDelta). */
  readonly onThinkingDelta?: (ev: ModelThinkingDeltaEvent) => void;
  /** A compaction (threshold or deferred) began running for this loop. */
  readonly onCompactionStart?: () => void;
  /** Fires when a mid-turn compaction completes with `compacted: true`. */
  readonly onCompaction?: () => void;
  /** A compaction attempt failed; the loop continues with current messages. */
  readonly onCompactionFailed?: () => void;
  /**
   * A compaction banner to inject into the turn's active output. Fired for
   * start / timeout / failure notices so the banner manager can deliver
   * them mid-turn (or fall back to a standalone status message).
   */
  readonly onCompactionBanner?: (banner: string) => void;
  /** Optional: enables mid-turn context compaction before each model call. */
  readonly compaction?: {
    readonly db: Database.Database;
    readonly sessionId: string;
    readonly contextSegmentId: string;
    readonly ctxWindowTokens: number;
    readonly reserveTokens: number;
    readonly modelsConfig: ShoggothModelsConfig | undefined;
    /** Dedicated compaction model as "providerId/modelName". Overrides the failover chain for compaction only. */
    readonly compactionModel?: string;
    readonly env: Record<string, string | undefined>;
    readonly systemPromptChars: number;
    readonly toolSchemaChars: number;
    readonly turnAbortSignal?: AbortSignal;
    readonly compactionAbortTimeoutMs: number;
  };
}): SessionToolLoopModelClient {
  let messages: ChatMessage[] = [...input.initialMessages];
  let banner: SessionToolLoopFailoverState | undefined;
  let degradedAny = false;
  let accumulatedInputTokens = 0;
  let accumulatedOutputTokens = 0;
  let accumulatedCachedInputTokens = 0;
  let accumulatedCacheWriteInputTokens = 0;
  let lastContextWindowTokens: number | undefined;
  let lastInputTokens: number | undefined;
  let hasUsage = false;
  let lastFinishReason: string | undefined;
  /** Monotonic tool-loop round index; scopes every streamed display event. */
  let nextRound = 0;

  const resolveTools = (): readonly OpenAIToolFunctionDefinition[] =>
    typeof input.tools === "function" ? input.tools() : input.tools;

  /**
   * One compaction pass with the CURRENT compaction config: build the
   * (compaction-model-overridden) failover client, summarize + replace the
   * DB transcript, and swap the in-memory history for the reloaded context.
   * No timeout, no events — callers own both. Throws on failure.
   */
  const executeCompaction = async (): Promise<{
    compacted: boolean;
    messageCount: number;
  }> => {
    const c = input.compaction;
    if (!c) return { compacted: false, messageCount: 0 };
    const policy = resolveCompactionPolicyFromModelsConfig(c.modelsConfig);
    let compactionModelsConfig = c.modelsConfig;
    if (c.compactionModel) {
      const slash = c.compactionModel.indexOf("/");
      if (slash > 0 && slash < c.compactionModel.length - 1) {
        const providerId = c.compactionModel.slice(0, slash);
        const modelName = c.compactionModel.slice(slash + 1);
        const provider = c.modelsConfig?.providers
          ? modelProvidersToEntries(c.modelsConfig.providers).find((p) => p.id === providerId)
          : undefined;
        if (provider) {
          const { id, ...body } = provider;
          compactionModelsConfig = {
            providers: { [id]: body },
            failoverChain: [id + "/" + modelName],
          } as unknown as ShoggothModelsConfig;
        }
      }
    }
    const compactionClient = createFailoverClientFromModelsConfig(compactionModelsConfig, {
      env: c.env,
    });
    const result = await compactSessionTranscript(c.db, c.sessionId, policy, compactionClient, {
      modelsConfig: c.modelsConfig,
    });
    if (result.compacted) {
      const reloaded = loadSessionTranscriptAsModelChat(c.db, c.sessionId, c.contextSegmentId);
      const systemMsg = messages.find((m) => m.role === "system");
      messages = systemMsg ? [systemMsg, ...reloaded] : [...reloaded];
      log.debug("mid-turn compaction completed", {
        sessionId: c.sessionId,
      });
      input.onCompaction?.();
    }
    return result;
  };

  /**
   * Threshold-path compaction: runs one pass with the start/failed events and
   * the configured abort timeout. On a timeout the pass keeps running in the
   * background (its completion still reloads the history), so no failure event
   * fires and the loop continues without waiting; on a real failure the pass
   * is dead and {@link onCompactionFailed} fires.
   */
  const runCompactionGuarded = async (): Promise<void> => {
    const c = input.compaction;
    if (!c) return;
    input.onCompactionStart?.();
    input.onCompactionBanner?.("> 🗑️ Mid-turn compaction triggered");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("compaction timeout")), c.compactionAbortTimeoutMs);
    });
    try {
      await Promise.race([executeCompaction(), timeoutPromise]);
    } catch (e) {
      if (String(e).includes("compaction timeout")) {
        input.onCompactionBanner?.(
          "> 🗑️⌛ Mid-turn compaction **timed out** *" +
            formatDuration(c.compactionAbortTimeoutMs) +
            "*",
        );
        log.warn("mid-turn compaction timed out, proceeding with current messages", {
          sessionId: c.sessionId,
        });
      } else {
        input.onCompactionBanner?.(
          "> 🗑️❌ Mid-turn compaction **failed**: " + (e instanceof Error ? e.message : String(e)),
        );
        input.onCompactionFailed?.();
        log.warn("mid-turn compaction failed, proceeding with current messages", {
          sessionId: c.sessionId,
          err: String(e),
        });
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * Deferred-path compaction (operator-triggered): runs one pass to
   * completion — no timeout — because the caller (the tool loop's deferred
   * break) holds the turn queue frozen until this settles; bailing early
   * would unfreeze the queue against a mid-rewrite transcript. Start/failed
   * events fire as usual; failures rethrow so the parked request can report.
   */
  const runCompactionToCompletion = async (): Promise<{
    compacted: boolean;
    messageCount: number;
  }> => {
    const c = input.compaction;
    if (!c) return { compacted: false, messageCount: 0 };
    input.onCompactionStart?.();

    input.onCompactionBanner?.("> 🗑️ Mid-turn compaction triggered");
    try {
      return await executeCompaction();
    } catch (e) {
      input.onCompactionBanner?.(
        "> 🗑️❌ Mid-turn compaction **failed**: " + (e instanceof Error ? e.message : String(e)),
      );
      input.onCompactionFailed?.();
      log.warn("deferred compaction failed", {
        sessionId: c.sessionId,
        err: String(e),
      });
      throw e;
    }
  };

  return {
    getSessionToolLoopFailoverState() {
      return banner;
    },

    getLastFinishReason() {
      return lastFinishReason;
    },

    async runCompaction() {
      return runCompactionToCompletion();
    },

    async runCompactionGuarded() {
      return runCompactionGuarded();
    },

    getAccumulatedUsage() {
      if (!hasUsage) return undefined;
      return {
        inputTokens: accumulatedInputTokens,
        outputTokens: accumulatedOutputTokens,
        ...(accumulatedCachedInputTokens > 0
          ? { cachedInputTokens: accumulatedCachedInputTokens }
          : {}),
        ...(accumulatedCacheWriteInputTokens > 0
          ? { cacheWriteInputTokens: accumulatedCacheWriteInputTokens }
          : {}),
        ...(lastContextWindowTokens != null
          ? { contextWindowTokens: lastContextWindowTokens }
          : {}),
      };
    },

    async complete() {
      // --- Mid-turn compaction check ---
      if (input.compaction) {
        const c = input.compaction;
        let allContent = "";
        for (const m of messages) {
          if (typeof m.content === "string") {
            allContent += m.content;
          } else if (Array.isArray(m.content)) {
            for (const p of m.content)
              if ("text" in p && typeof p.text === "string") allContent += p.text;
          }
          if (typeof m.reasoningContent === "string") {
            allContent += m.reasoningContent;
          }
          if (m.toolCalls) {
            for (const tc of m.toolCalls) allContent += tc.arguments;
          }
        }
        const estimatedTokens =
          c.systemPromptChars / 4 + c.toolSchemaChars / 2 + estimateTokensFromContent(allContent);
        // Threshold against the smaller of the configured window and the
        // serving model's provider-reported window (when finite and positive),
        // so a failover model with a smaller window cannot overflow.
        const servingWindowTokens =
          lastContextWindowTokens != null &&
          Number.isFinite(lastContextWindowTokens) &&
          lastContextWindowTokens > 0
            ? lastContextWindowTokens
            : undefined;
        const effectiveWindowTokens =
          servingWindowTokens != null
            ? Math.min(c.ctxWindowTokens, servingWindowTokens)
            : c.ctxWindowTokens;
        // Provider-reported input tokens are ground truth for what was really
        // sent this turn (the char heuristic undercounts); use them directly
        // whenever available and fall back to the heuristic only when the
        // provider reported no usage yet.
        const actualInputTokens =
          lastInputTokens != null && Number.isFinite(lastInputTokens) && lastInputTokens > 0
            ? lastInputTokens
            : undefined;
        const contextFillTokens = actualInputTokens ?? estimatedTokens;
        if (contextFillTokens > effectiveWindowTokens - c.reserveTokens) {
          log.debug("mid-turn compaction triggered", {
            sessionId: c.sessionId,
            estimatedTokens: Math.round(estimatedTokens),
            contextFillTokens: Math.round(contextFillTokens),
            usedProviderActuals: actualInputTokens != null,
            ctxWindowTokens: c.ctxWindowTokens,
            effectiveWindowTokens,
            reserveTokens: c.reserveTokens,
          });
          try {
            await runCompactionGuarded();
          } catch {
            // The guarded run already logged and fired the failure event;
            // the loop continues with the current messages either way.
          }

          if (c.turnAbortSignal?.aborted) {
            log.debug("abort deferred until compaction completed", {
              sessionId: c.sessionId,
            });
            throw new TurnAbortedError();
          }
        }
      }

      const round = nextRound++;
      const streamOpts =
        input.streamModel === true
          ? {
              stream: true as const,
              onTextDelta: (delta: string, accumulated: string) => {
                void Promise.resolve(input.onModelTextDelta?.({ delta, accumulated, round })).catch(
                  () => {},
                );
              },
              onReasoningDelta: (_delta: string, accumulated: string) => {
                input.onThinkingDelta?.({ accumulated, round });
              },
            }
          : {};

      const inv = input.modelInvocation ?? {};
      const out = await input.toolClient
        .completeWithTools({
          messages,
          tools: resolveTools(),
          maxOutputTokens: inv.maxOutputTokens,
          temperature: inv.temperature,
          thinking: inv.thinking,
          thinkingFormat: inv.thinkingFormat,
          reasoningEffort: inv.reasoningEffort,
          requestExtras: inv.requestExtras,
          responseSchema: inv.responseSchema,
          structuredOutputMode: inv.structuredOutputMode,
          signal: input.turnAbortSignal,
          ...streamOpts,
        })
        .catch((e: unknown) => {
          // Abort mid-request/stream: the provider layer already closed the
          // response stream; surface the daemon's turn-abort error type.
          if (e instanceof ModelRequestAbortedError) throw new TurnAbortedError();
          throw e;
        });
      degradedAny = degradedAny || out.degraded;
      banner = {
        degraded: degradedAny,
        usedModel: out.usedModel,
        usedProviderId: out.usedProviderId,
      };
      // Track the last *reported* finish reason (keep prior when a hop omits
      // it) so the turn-end log can surface output-limit truncation (`length`)
      // even when a later round doesn't report one.
      if (out.finishReason !== undefined) lastFinishReason = out.finishReason;

      if (out.usage) {
        hasUsage = true;
        lastInputTokens = out.usage.inputTokens;
        accumulatedInputTokens += out.usage.inputTokens;
        accumulatedOutputTokens += out.usage.outputTokens;
        if (out.usage.cachedInputTokens != null) {
          accumulatedCachedInputTokens += out.usage.cachedInputTokens;
        }
        if (out.usage.cacheWriteInputTokens != null) {
          accumulatedCacheWriteInputTokens += out.usage.cacheWriteInputTokens;
        }
        if (out.usage.contextWindowTokens != null) {
          lastContextWindowTokens = out.usage.contextWindowTokens;
        }
        input.onUsageDelta?.({
          inputTokens: out.usage.inputTokens,
          outputTokens: out.usage.outputTokens,
          ...(out.usage.cachedInputTokens != null
            ? { cachedInputTokens: out.usage.cachedInputTokens }
            : {}),
          ...(out.usage.cacheWriteInputTokens != null
            ? { cacheWriteInputTokens: out.usage.cacheWriteInputTokens }
            : {}),
          ...(out.usage.contextWindowTokens != null
            ? { contextWindowTokens: out.usage.contextWindowTokens }
            : {}),
        });
      }

      // The round is settled: hand the display layer the authoritative final
      // content so it can reconcile any drifted streamed tail and keep the
      // display round-truthful across tool follow-ups.
      if (input.streamModel === true) {
        input.onModelRoundEnd?.({ round, content: out.content ?? "" });
      }

      if (out.toolCalls.length > 0) {
        // The assistant turn is replayed to the provider on the next request,
        // so its tool-call arguments MUST be parseable: a provider that
        // truncates a response mid-arguments leaves an incomplete JSON
        // prefix, and replaying that verbatim makes the upstream reject the
        // whole request with an opaque 400 (no detail about which call or
        // why). Normalizing here keeps the replayed history well-formed.
        //
        // The RAW arguments are still returned to the tool loop, which needs
        // them to tell a truncated call (unrecoverable — the arguments are an
        // incomplete prefix) from a merely malformed one (the model can
        // retry).
        const replayableToolCalls = out.toolCalls.map((tc) => ({
          ...tc,
          arguments: normalizeToolCallArgsJson(tc.arguments),
        }));
        messages = [
          ...messages,
          {
            role: "assistant",
            content: out.content,
            toolCalls: replayableToolCalls,
            ...(out.reasoningContent ? { reasoningContent: out.reasoningContent } : {}),
          },
        ];
        return {
          content: out.content,
          toolCalls: out.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            argsJson: tc.arguments,
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          })),
          reasoningContent: out.reasoningContent,
          // Provider stop reason for THIS round. `length` / `max_tokens` means
          // the response was cut off at the output-token limit — the tool call's
          // arguments may be truncated mid-JSON. The tool loop needs this to
          // tell a truncated call (unrecoverable) from a merely malformed one
          // (the model can retry).
          finishReason: out.finishReason,
        };
      }

      messages = [
        ...messages,
        {
          role: "assistant",
          content: out.content ?? "",
          ...(out.reasoningContent ? { reasoningContent: out.reasoningContent } : {}),
        },
      ];
      return { content: out.content, toolCalls: [], reasoningContent: out.reasoningContent };
    },

    pushToolMessage({ toolCallId, content }) {
      messages = [
        ...messages,
        {
          role: "tool",
          toolCallId,
          content,
        },
      ];
    },

    pushSteerMessage(content) {
      messages = [...messages, { role: "user", content }];
    },
  };
}
