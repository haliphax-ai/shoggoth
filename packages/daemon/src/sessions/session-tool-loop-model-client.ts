import type {
  ChatMessage,
  FailoverToolCallingClient,
  ModelInvocationParams,
  ModelUsage,
  OpenAIToolFunctionDefinition,
} from "@shoggoth/models";
import type { ModelClient } from "./tool-loop";

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
