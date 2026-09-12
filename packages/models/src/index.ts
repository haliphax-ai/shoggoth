export { isFailoverEligibleError } from "./classify";
export { EmptyModelResponseError, ModelHttpError } from "./errors";
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
  iterateFailoverChain,
  type FailoverChainEntry,
  type FailoverCompleteInput,
  type FailoverCompleteOutput,
  type FailoverHooks,
  type FailoverModelClient,
} from "./failover";
export type {
  ChatMessage,
  ChatRole,
  ChatContentPart,
  ImageBlock,
  ImageBlockCodec,
  ModelProvider,
  ModelCapabilities,
  ModelCompleteInput,
  ModelCompleteOutput,
  ModelInvocationParams,
  ModelThinkingOptions,
  ModelUsage,
  ResponseSchema,
} from "./types";
export {
  estimateTranscriptChars,
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
  wrapCodecWithCapabilities,
} from "./image-codec";
export { extractXmlThinkingBlocks, normalizeThinkingBlocks } from "./thinking-normalize";
export { headersToRecord } from "./headers-to-record";
export { parseApiErrorBody } from "./parse-api-error-body";
export { trimSlash } from "./trim-slash";
export {
  STRUCTURED_OUTPUT_TOOL_NAME,
  SYNTHETIC_TOOL_DESCRIPTION,
  buildSyntheticTool,
  isSyntheticToolCall,
} from "./structured-output-utils";
export {
  resolveStructuredOutputMode,
  validateResponseSchema,
  StructuredOutputValidationError,
  type StructuredOutputMode,
  type ValidationSuccess,
  type ValidationFailure,
  type ValidationResult,
} from "./response-validation";

// Resilience layer
export type {
  ResilienceOptions,
  ProviderResilienceConfig,
  ErrorClassification,
  BackoffConfig,
  ParsedRateLimitHeaders,
} from "./resilience/index";
export {
  ModelResilienceGate,
  setResilienceGate,
  getResilienceGate,
  classifyModelError,
  RETRYABLE_STATUSES,
  DEFAULT_BACKOFF_CONFIG,
  computeBackoffDelay,
  BackoffState,
  parseRateLimitHeaders,
  ProviderResilienceManager,
} from "./resilience/index";
