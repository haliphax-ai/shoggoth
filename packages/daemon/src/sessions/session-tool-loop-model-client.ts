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
} from "@shoggoth/models";
import type { ShoggothModelsConfig } from "@shoggoth/shared";
import { compactSessionTranscript } from "../transcript-compact";
import { loadSessionTranscriptAsModelChat } from "./transcript-to-chat";
import { TurnAbortedError } from "./session-turn-abort";
import { getLogger } from "../logging";
import type { ModelClient } from "./tool-loop";

const log = getLogger("session-tool-loop-model-client");

export interface SessionToolLoopModelClient extends ModelClient {
  /** Best-effort failover metadata from the most recent `completeWithTools` hop. */
  getSessionToolLoopFailoverState(): SessionToolLoopFailoverState | undefined;
  /** Accumulated token usage across all `completeWithTools` calls in this tool loop. */
  getAccumulatedUsage(): ModelUsage | undefined;
}

export interface SessionToolLoopFailoverState {
  readonly degraded: boolean;
  readonly usedModel: string;
  readonly usedProviderId: string;
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
  readonly tools: readonly OpenAIToolFunctionDefinition[] | (() => readonly OpenAIToolFunctionDefinition[]);
  /** Per-turn parameters forwarded to each `completeWithTools` (merged with stream options). */
  readonly modelInvocation?: ModelInvocationParams;
  /**
   * When true, passes `stream: true` to `completeWithTools` (OpenAI SSE). Use with
   * {@link onModelTextDelta} for live display (e.g. streaming edits on a message platform).
   */
  readonly streamModel?: boolean;
  /**
   * Receives **display** text: prior model reply rounds in this tool loop (if any) plus the
   * current stream's accumulated model content. Only invoked when `streamModel` is true.
   */
  readonly onModelTextDelta?: (displayText: string) => void | Promise<void>;
  /**
   * Fires after each `complete()` call with the per-call token delta (not accumulated totals).
   * Use for incremental stats persistence so mid-turn queries see up-to-date numbers.
   */
  readonly onUsageDelta?: (delta: ModelUsage) => void;
  /** Optional: enables mid-turn context compaction before each model call. */
  readonly compaction?: {
    readonly db: Database.Database;
    readonly sessionId: string;
    readonly contextSegmentId: string;
    readonly ctxWindowTokens: number;
    readonly reserveTokens: number;
    readonly modelsConfig: ShoggothModelsConfig | undefined;
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
  let lastContextWindowTokens: number | undefined;
  let hasUsage = false;
  /** Model reply text from earlier `complete()` rounds that returned tool calls (for streaming display). */
  let priorRoundsStreamText = "";

  const resolveTools = (): readonly OpenAIToolFunctionDefinition[] =>
    typeof input.tools === "function" ? input.tools() : input.tools;

  return {
    getSessionToolLoopFailoverState() {
      return banner;
    },

    getAccumulatedUsage() {
      if (!hasUsage) return undefined;
      return {
        inputTokens: accumulatedInputTokens,
        outputTokens: accumulatedOutputTokens,
        ...(lastContextWindowTokens != null ? { contextWindowTokens: lastContextWindowTokens } : {}),
      };
    },

    async complete() {
      // --- Mid-turn compaction check ---
      if (input.compaction) {
        const c = input.compaction;
        let textChars = 0;
        let jsonChars = 0;
        for (const m of messages) {
          const contentLen = typeof m.content === "string" ? m.content.length
            : Array.isArray(m.content) ? m.content.reduce((n, p) => n + ("text" in p && typeof p.text === "string" ? p.text.length : 0), 0)
            : 0;
          if (m.role === "tool") {
            jsonChars += contentLen;
          } else {
            textChars += contentLen;
          }
          if (m.toolCalls) {
            for (const tc of m.toolCalls) jsonChars += tc.arguments.length;
          }
        }
        const estimatedTokens = (c.systemPromptChars / 4) + (c.toolSchemaChars / 2) + (textChars / 4) + (jsonChars / 2);
        if (estimatedTokens > c.ctxWindowTokens - c.reserveTokens) {
          log.debug("mid-turn compaction triggered", { sessionId: c.sessionId, estimatedTokens: Math.round(estimatedTokens), ctxWindowTokens: c.ctxWindowTokens, reserveTokens: c.reserveTokens });
          const compactionPromise = (async () => {
            const policy = resolveCompactionPolicyFromModelsConfig(c.modelsConfig);
            const compactionClient = createFailoverClientFromModelsConfig(c.modelsConfig, { env: c.env });
            const { compacted } = await compactSessionTranscript(c.db, c.sessionId, policy, compactionClient, { modelsConfig: c.modelsConfig, force: true });
            if (compacted) {
              const reloaded = loadSessionTranscriptAsModelChat(c.db, c.sessionId, c.contextSegmentId);
              const systemMsg = messages.find((m) => m.role === "system");
              messages = systemMsg ? [systemMsg, ...reloaded] : [...reloaded];
              log.debug("mid-turn compaction completed", { sessionId: c.sessionId });
            }
          })();

          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error("compaction timeout")), c.compactionAbortTimeoutMs);
          });

          try {
            await Promise.race([compactionPromise, timeoutPromise]);
          } catch (e) {
            if (String(e).includes("compaction timeout")) {
              log.warn("mid-turn compaction timed out, proceeding with current messages", { sessionId: c.sessionId });
            } else {
              log.warn("mid-turn compaction failed, proceeding with current messages", { sessionId: c.sessionId, err: String(e) });
            }
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }

          if (c.turnAbortSignal?.aborted) {
            log.debug("abort deferred until compaction completed", { sessionId: c.sessionId });
            throw new TurnAbortedError();
          }
        }
      }

      const streamOpts =
        input.streamModel === true
          ? {
              stream: true as const,
              onTextDelta: (_delta: string, accumulated: string) => {
                const display = priorRoundsStreamText + accumulated;
                void Promise.resolve(input.onModelTextDelta?.(display)).catch(() => {});
              },
            }
          : {};

      const inv = input.modelInvocation ?? {};
      const out = await input.toolClient.completeWithTools({
        messages,
        tools: resolveTools(),
        maxOutputTokens: inv.maxOutputTokens,
        temperature: inv.temperature,
        thinking: inv.thinking,
        thinkingFormat: inv.thinkingFormat,
        reasoningEffort: inv.reasoningEffort,
        requestExtras: inv.requestExtras,
        ...streamOpts,
      });
      degradedAny = degradedAny || out.degraded;
      banner = {
        degraded: degradedAny,
        usedModel: out.usedModel,
        usedProviderId: out.usedProviderId,
      };

      if (out.usage) {
        hasUsage = true;
        accumulatedInputTokens += out.usage.inputTokens;
        accumulatedOutputTokens += out.usage.outputTokens;
        if (out.usage.contextWindowTokens != null) {
          lastContextWindowTokens = out.usage.contextWindowTokens;
        }
        input.onUsageDelta?.({
          inputTokens: out.usage.inputTokens,
          outputTokens: out.usage.outputTokens,
          ...(out.usage.contextWindowTokens != null ? { contextWindowTokens: out.usage.contextWindowTokens } : {}),
        });
      }

      if (out.toolCalls.length > 0) {
        const piece = out.content?.trim() ? out.content : "";
        if (piece) {
          priorRoundsStreamText += priorRoundsStreamText ? `\n\n${piece}` : piece;
        }
        messages = [
          ...messages,
          {
            role: "assistant",
            content: out.content,
            toolCalls: out.toolCalls,
          },
        ];
        return {
          content: out.content,
          toolCalls: out.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            argsJson: tc.arguments,
          })),
        };
      }

      messages = [
        ...messages,
        {
          role: "assistant",
          content: out.content ?? "",
        },
      ];
      return { content: out.content, toolCalls: [] };
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
  };
}
