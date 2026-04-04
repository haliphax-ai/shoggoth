export { isFailoverEligibleError } from "./classify";
export { ModelHttpError } from "./errors";
export {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderOptions,
  type FetchLike,
} from "./openai-compatible";
export {
  buildOpenAiToAnthropicToolNameMap,
  consumeAnthropicMessagesStream,
  createAnthropicMessagesProvider,
  mapChatMessagesToAnthropicPayload,
  normalizeAnthropicMessagesOrigin,
  normalizeAnthropicWireModelId,
  type AnthropicMessagesAuthStyle,
  type AnthropicMessagesProviderOptions,
  type ConsumeAnthropicMessagesStreamOptions,
} from "./anthropic-messages";
export {
  consumeGeminiStream,
  createGeminiProvider,
  mapChatMessagesToGeminiPayload,
  type ConsumeGeminiStreamOptions,
  type GeminiProviderOptions,
} from "./gemini";
export {
  createFailoverModelClient,
  type FailoverChainEntry,
  type FailoverCompleteInput,
  type FailoverCompleteOutput,
  type FailoverModelClient,
} from "./failover";
export type {
  ChatMessage,
  ChatRole,
  ChatContentPart,
  ImageBlock,
  ImageBlockCodec,
  ModelProvider,
  ModelCompleteInput,
  ModelCompleteOutput,
  ModelInvocationParams,
  ModelThinkingOptions,
  ModelUsage,
} from "./types";
export {
  estimateTranscriptChars,
  shouldAutoCompact,
  compactTranscriptIfNeeded,
  type CompactionPolicy,
  type CompactTranscriptOptions,
  type CompactTranscriptResult,
} from "./compaction";
export {
  createFailoverClientFromModelsConfig,
  createFailoverToolCallingClientFromModelsConfig,
  resolveCompactionPolicyFromModelsConfig,
  type CreateFailoverFromConfigOptions,
} from "./from-config";
export {
  createFailoverToolCallingClient,
  type FailoverToolCallingClient,
  type FailoverToolCompleteOutput,
} from "./tool-failover";
export type {
  ChatToolCall,
  ModelStreamTextDeltaCallback,
  ModelToolCompleteInput,
  ModelToolCompleteOutput,
  OpenAIToolFunctionDefinition,
} from "./types";
export {
  mergeModelInvocationParams,
  mergeModelInvocationOverlay,
  mergeSubagentSpawnModelSelection,
  parseModelInvocationFromUnknown,
} from "./invocation-merge";
export {
  getImageBlockCodec,
  openaiImageBlockCodec,
  anthropicImageBlockCodec,
  geminiImageBlockCodec,
} from "./image-codec";

// Resilience layer
export type { ResilienceOptions, ProviderResilienceConfig, ErrorClassification, BackoffConfig, ParsedRateLimitHeaders } from "./resilience/index";
export { ModelResilienceGate, setResilienceGate, getResilienceGate, classifyModelError, DEFAULT_BACKOFF_CONFIG, computeBackoffDelay, BackoffState, parseRateLimitHeaders, ProviderResilienceManager } from "./resilience/index";
