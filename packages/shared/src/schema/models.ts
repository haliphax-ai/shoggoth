import { z } from "zod";
import {
  providerRetryFields,
  responseSchemaSchema,
  structuredOutputModeSchema,
} from "./common";

export const shoggothOpenAiCompatibleProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("openai-compatible"),
    baseUrl: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    /** When true, pass image URLs directly to the provider instead of fetching and base64-encoding. Only effective when the provider supports URL-based image sources. Default false. */
    imageUrlPassthrough: z.boolean().optional(),
    ...providerRetryFields,
  })
  .strict();

export const shoggothAnthropicMessagesProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("anthropic-messages"),
    /** API origin (or URL whose origin is used); POST `{origin}/v1/messages`. */
    baseUrl: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    anthropicVersion: z.string().min(1).optional(),
    /** Default `x-api-key`; `bearer` sets `Authorization: Bearer`. */
    auth: z.enum(["x-api-key", "bearer"]).optional(),
    /** When true, pass image URLs directly to the provider instead of fetching and base64-encoding. Only effective when the provider supports URL-based image sources. Default false. */
    imageUrlPassthrough: z.boolean().optional(),
    ...providerRetryFields,
  })
  .strict();

export const shoggothGeminiProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("gemini"),
    /** API origin, e.g. "https://generativelanguage.googleapis.com". Defaults in provider factory when omitted. */
    baseUrl: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    /** API version path segment (default "v1beta"). */
    apiVersion: z.string().min(1).optional(),
    ...providerRetryFields,
  })
  .strict();

export const shoggothModelProviderEntrySchema = z.discriminatedUnion("kind", [
  shoggothOpenAiCompatibleProviderSchema,
  shoggothAnthropicMessagesProviderSchema,
  shoggothGeminiProviderSchema,
]);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type _ShoggothModelProviderEntry = z.infer<typeof shoggothModelProviderEntrySchema>;

export const shoggothModelThinkingSchema = z
  .object({
    enabled: z.boolean(),
    budgetTokens: z.number().int().positive().optional(),
  })
  .strict();

export const shoggothModelDefaultInvocationSchema = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    thinking: shoggothModelThinkingSchema.optional(),
    reasoningEffort: z.string().min(1).optional(),
    requestExtras: z.record(z.string(), z.unknown()).optional(),
    responseSchema: responseSchemaSchema,
    structuredOutputMode: structuredOutputModeSchema,
  })
  .strict();

export const shoggothModelFailoverHopSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    contextWindowTokens: z.number().int().positive().optional(),
    thinkingFormat: z.enum(["native", "xml-tags", "none"]).optional(),
    capabilities: z
      .object({
        imageInput: z.boolean().optional(),
        thinkingFormat: z.enum(["native", "xml-tags", "none"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ShoggothModelFailoverHop = z.infer<typeof shoggothModelFailoverHopSchema>;

/** Simplified failover chain entry: string ref like 'providerId/model'. */
export const failoverChainEntrySchema = z.string().min(1);

export type FailoverChainEntry = z.infer<typeof failoverChainEntrySchema>;

/** Global retry / failure configuration for model resolution. */
export const modelsRetrySchema = z
  .object({
    maxRetries: z.number().int().nonnegative().optional(),
    retryDelayMs: z.number().int().nonnegative().optional(),
    retryBackoffMultiplier: z.number().positive().optional(),
    markFailedDurationMs: z.number().int().positive().optional(),
  })
  .strict();

export type ModelsRetry = z.infer<typeof modelsRetrySchema>;

export const shoggothModelsCompactionSchema = z
  .object({
    /** Dedicated compaction model as "providerId/modelName". When set, compaction uses this model instead of the agent's failover chain. */
    model: z.string().min(1).optional(),
    preserveRecentMessages: z.number().int().nonnegative().optional(),
    summaryMaxOutputTokens: z.number().int().positive().optional(),
    /** Trigger inline compaction when estimated token usage exceeds (contextWindow − reserveTokens). Default 20 000. */
    contextWindowReserveTokens: z.number().int().positive().optional(),
    /** Maximum time (ms) to wait for compaction to complete before honoring an abort. Default 60000 (60s). */
    compactionAbortTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export type ShoggothModelsCompaction = z.infer<typeof shoggothModelsCompactionSchema>;

export const shoggothModelsCompactionPartialSchema = shoggothModelsCompactionSchema.partial();

/** Per-agent model stack / invocation / compaction overrides (merged with global `models`). */
export const shoggothAgentModelsOverrideSchema = z
  .object({
    failoverChain: z.array(shoggothModelFailoverHopSchema).min(1).optional(),
    primary: shoggothModelFailoverHopSchema.optional(),
    defaultInvocation: shoggothModelDefaultInvocationSchema.optional(),
    compaction: shoggothModelsCompactionPartialSchema.optional(),
  })
  .strict()
  .refine((v) => !(v.primary != null && v.failoverChain != null && v.failoverChain.length > 0), {
    message: "agent models: set only one of primary or failoverChain",
  });

export type ShoggothAgentModelsOverride = z.infer<typeof shoggothAgentModelsOverrideSchema>;

export const shoggothModelsConfigSchema = z
  .object({
    providers: z.array(shoggothModelProviderEntrySchema).optional(),
    failoverChain: z.array(failoverChainEntrySchema).optional(),
    /** Default model call parameters; per-session `model_selection` JSON overrides by field. */
    defaultInvocation: shoggothModelDefaultInvocationSchema.optional(),
    compaction: shoggothModelsCompactionSchema.optional(),
    /** Global retry / failure configuration for model resolution. */
    retry: modelsRetrySchema.optional(),
  })
  .strict();

export type ShoggothModelsConfig = z.infer<typeof shoggothModelsConfigSchema>;
