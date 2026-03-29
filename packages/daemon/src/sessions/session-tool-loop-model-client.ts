import type {
  ChatMessage,
  FailoverToolCallingClient,
  OpenAIToolFunctionDefinition,
} from "@shoggoth/models";
import type { ModelClient } from "./tool-loop";

export interface SessionToolLoopModelClient extends ModelClient {
  /** Best-effort failover metadata from the most recent `completeWithTools` hop. */
  getSessionToolLoopFailoverState(): SessionToolLoopFailoverState | undefined;
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
  readonly tools: readonly OpenAIToolFunctionDefinition[];
  /**
   * When true, passes `stream: true` to `completeWithTools` (OpenAI SSE). Use with
   * {@link onModelTextDelta} for live display (e.g. streaming edits on a message platform).
   */
  readonly streamModel?: boolean;
  /**
   * Receives **display** text: prior model reply rounds in this tool loop (if any) plus the
   * current stream’s accumulated model content. Only invoked when `streamModel` is true.
   */
  readonly onModelTextDelta?: (displayText: string) => void | Promise<void>;
}): SessionToolLoopModelClient {
  let messages: ChatMessage[] = [...input.initialMessages];
  let banner: SessionToolLoopFailoverState | undefined;
  let degradedAny = false;
  /** Model reply text from earlier `complete()` rounds that returned tool calls (for streaming display). */
  let priorRoundsStreamText = "";

  return {
    getSessionToolLoopFailoverState() {
      return banner;
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

      const out = await input.toolClient.completeWithTools({
        messages,
        tools: input.tools,
        ...streamOpts,
      });
      degradedAny = degradedAny || out.degraded;
      banner = {
        degraded: degradedAny,
        usedModel: out.usedModel,
        usedProviderId: out.usedProviderId,
      };

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
