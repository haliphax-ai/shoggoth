export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One function tool call from the model (OpenAI `tool_calls[]` item, flattened). */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ChatMessage {
  readonly role: ChatRole;
  /** Empty string is sent when omitted for non-tool assistant turns; use null only with toolCalls. */
  readonly content?: string | null;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ChatToolCall[];
}

/** OpenAI `tools` array entry (`type: function`). */
export interface OpenAIToolFunctionDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** Optional callback for streaming assistant text (`stream: true` on OpenAI-compatible providers). */
export type ModelStreamTextDeltaCallback = (delta: string, accumulated: string) => void;

export interface ModelToolCompleteInput {
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAIToolFunctionDefinition[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** When true, request SSE (`stream: true`); omitted or false keeps JSON non-streaming behavior. */
  readonly stream?: boolean;
  readonly onTextDelta?: ModelStreamTextDeltaCallback;
}

export interface ModelToolCompleteOutput {
  readonly content: string | null;
  readonly toolCalls: readonly ChatToolCall[];
}

export interface ModelCompleteInput {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
  readonly onTextDelta?: ModelStreamTextDeltaCallback;
}

export interface ModelCompleteOutput {
  readonly content: string;
}

export interface ModelProvider {
  readonly id: string;
  complete(input: ModelCompleteInput): Promise<ModelCompleteOutput>;
  /** OpenAI-style chat completions with `tools` + `tool_calls` / tool messages. */
  completeWithTools(input: ModelToolCompleteInput): Promise<ModelToolCompleteOutput>;
}
