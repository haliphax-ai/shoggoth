export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One function tool call from the model (OpenAI `tool_calls[]` item, flattened). */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Provider-agnostic image content block. At least one of base64 or url must be present. */
export interface ImageBlock {
  readonly type: "image";
  /** e.g. "image/jpeg", "image/png", "image/gif", "image/webp" */
  readonly mediaType: string;
  /** Raw image bytes, base64-encoded (no data-URI prefix). */
  readonly base64?: string;
  /** Source URL for the image. */
  readonly url?: string;
}

/** A single content part in a structured message. */
export type ChatContentPart =
  | { readonly type: "text"; readonly text: string }
  | ImageBlock;

/** Codec for translating between canonical ImageBlock and provider wire format. */
export interface ImageBlockCodec {
  /** Canonical ImageBlock → provider wire JSON content part. */
  encode(block: ImageBlock): unknown;
  /** Provider wire content part → canonical ImageBlock, or null if not an image part. */
  decode(part: unknown): ImageBlock | null;
  /** Whether this provider supports URL-based image sources. */
  readonly supportsUrl: boolean;
  /** Whether this provider accepts image content in messages. */
  readonly supportsImageInput: boolean;
}

export interface ChatMessage {
  readonly role: ChatRole;
  /** Empty string is sent when omitted for non-tool assistant turns; use null only with toolCalls. */
  readonly content?: string | ChatContentPart[] | null;
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

/**
 * Extended thinking (Anthropic Messages `thinking` block). When `enabled`, providers that support it
 * send `budget_tokens` (default applied in the Anthropic adapter when omitted).
 */
export interface ModelThinkingOptions {
  readonly enabled: boolean;
  readonly budgetTokens?: number;
}

/**
 * Model capabilities describing provider-specific feature support.
 */
export interface ModelCapabilities {
  /** Whether this provider accepts image content in messages. */
  readonly imageInput?: boolean;
  /**
   * Format for extended thinking output when supported by the provider.
   * - `"native"`: Provider returns thinking in its native format (e.g., Anthropic `thinking` blocks).
   * - `"xml-tags"`: Provider wraps thinking in XML tags like `<thinking>...</thinking>`.
   * - `"none"`: Provider does not support extended thinking or it is disabled.
   * Defaults to undefined (treated as `"none"`).
   */
  readonly thinkingFormat?: "native" | "xml-tags" | "none";
}

/**
 * Cross-provider knobs merged into HTTP JSON bodies where the upstream supports them.
 * Configure globally under `models.defaultInvocation` and per-session via `sessions.model_selection`.
 */
export interface ModelInvocationParams {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly thinking?: ModelThinkingOptions;
  /** OpenAI-style chat completions `reasoning_effort` when the gateway honors it. */
  readonly reasoningEffort?: string;
  /** Format for extended thinking output from the active provider. */
  readonly thinkingFormat?: "native" | "xml-tags" | "none";
  /** Shallow-merged into the provider request object after built-in fields (escape hatch). */
  readonly requestExtras?: Record<string, unknown>;
}

export interface ModelToolCompleteInput extends ModelInvocationParams {
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAIToolFunctionDefinition[];
  /** When true, request SSE (`stream: true`); omitted or false keeps JSON non-streaming behavior. */
  readonly stream?: boolean;
  readonly onTextDelta?: ModelStreamTextDeltaCallback;
}

/** Token usage metadata returned by model providers (when available). */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Model's maximum context window size (when reported by the provider). */
  readonly contextWindowTokens?: number;
}

export interface ModelToolCompleteOutput {
  readonly content: string | null;
  readonly toolCalls: readonly ChatToolCall[];
  readonly usage?: ModelUsage;
}

export interface ModelCompleteInput extends ModelInvocationParams {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream?: boolean;
  readonly onTextDelta?: ModelStreamTextDeltaCallback;
}

export interface ModelCompleteOutput {
  readonly content: string;
  readonly usage?: ModelUsage;
}

export interface ModelProvider {
  readonly id: string;
  readonly capabilities?: ModelCapabilities;
  complete(input: ModelCompleteInput): Promise<ModelCompleteOutput>;
  /** OpenAI-style chat completions with `tools` + `tool_calls` / tool messages. */
  completeWithTools(input: ModelToolCompleteInput): Promise<ModelToolCompleteOutput>;
}
