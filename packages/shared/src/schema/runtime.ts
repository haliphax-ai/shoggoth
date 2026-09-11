import { z } from "zod";

export const shoggothPluginEntrySchema = z.object({ id: z.string().min(1).optional(), path: z.string().min(1).optional(), package: z.string().min(1).optional() }).strict().superRefine((p, ctx) => { const n = Number(Boolean(p.path)) + Number(Boolean(p.package)); if (n !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "each plugin entry must specify exactly one of path or package" }); });
export type ShoggothPluginEntry = z.infer<typeof shoggothPluginEntrySchema>;
export const shoggothSkillsConfigSchema = z.object({ scanRoots: z.array(z.string().min(1)), disabledIds: z.array(z.string().min(1)) }).strict();
export type ShoggothSkillsConfig = z.infer<typeof shoggothSkillsConfigSchema>;
export const DEFAULT_SKILLS_CONFIG: ShoggothSkillsConfig = { scanRoots: ["skills"], disabledIds: [] };
export const shoggothRetentionConfigSchema = z.object({ inboundMediaMaxAgeDays: z.number().int().positive().optional(), inboundMediaMaxTotalBytes: z.number().int().positive().optional(), transcriptMessageMaxAgeDays: z.number().int().positive().optional(), transcriptMaxMessagesPerSession: z.number().int().positive().optional(), kvMaxEntries: z.number().int().positive().optional() }).strict();
export type ShoggothRetentionConfig = z.infer<typeof shoggothRetentionConfigSchema>;
export const shoggothSearxngConfigSchema = z.object({ baseUrl: z.string(), apiKey: z.string().optional(), defaultCount: z.number().int().min(1).max(20).optional(), defaultLanguage: z.string().optional(), defaultTimeRange: z.enum(["day", "week", "month", "year"]).optional(), engines: z.array(z.string()).optional() }).strict();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ShoggothSearxngConfig = z.infer<typeof shoggothSearxngConfigSchema>;
export const shoggothAcpxConfigSchema = z.object({ binary: z.string().min(1).optional(), defaultArgs: z.array(z.string()).optional() }).strict();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ShoggothAcpxConfig = z.infer<typeof shoggothAcpxConfigSchema>;

const mediaGenerationAdapterType = z.enum(["openrouter-video","openai-images","openai-chat-image","openai-video-async","gemini-generate-content","gemini-predict","gemini-long-running"]);
const mediaGenerationModelSchema = z.object({ name: z.string().min(1), mediaType: z.enum(["image", "video", "audio"]), adapter: mediaGenerationAdapterType.optional(), modalities: z.array(z.string()).optional() });
const mediaGenerationProviderSchema = z.object({ id: z.string().min(1), kind: z.enum(["openai-compatible", "gemini"]), baseUrl: z.string().min(1), apiKey: z.string().optional(), apiKeyEnv: z.string().optional(), apiVersion: z.string().optional(), models: z.array(mediaGenerationModelSchema).optional().default([]) });
const mediaGenerationAdapterDefaults = z.object({ pollIntervalMs: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() });
export const shoggothMediaGenerationConfigSchema = z.object({ providers: z.array(mediaGenerationProviderSchema).optional().default([]), adapterDefaults: z.record(mediaGenerationAdapterType, mediaGenerationAdapterDefaults).optional(), outputDirectory: z.string().min(1).optional() }).strict();
export type ShoggothMediaGenerationConfig = z.infer<typeof shoggothMediaGenerationConfigSchema>;

export const shoggothRuntimeConfigSchema = z.object({
  agentId: z.string().min(1).refine((s) => !s.includes(":"), "must not contain ':'").optional(),
  drainTimeoutMs: z.number().int().positive().optional(), bootStaleClaimMs: z.number().int().nonnegative().optional(),
  heartbeatIntervalMs: z.number().int().positive().optional(), cronTickIntervalMs: z.number().int().positive().optional(),
  heartbeatBatchSize: z.number().int().positive().optional(), heartbeatConcurrency: z.number().int().positive().optional(),
  retentionScheduleIntervalMs: z.number().int().nonnegative().optional(), configHotReload: z.boolean().optional(),
  mcpLogServerMessages: z.boolean().optional(), openaiBaseUrl: z.string().min(1).optional(), ollamaHost: z.string().min(1).optional(),
  suppressContextWindowMismatchNotice: z.boolean().optional(),
  minimalContext: z.object({ transcriptTailMessages: z.number().int().nonnegative().optional() }).strict().optional(),
  turnQueue: z.object({ starvationThreshold: z.number().int().positive().optional(), maxDepth: z.number().int().positive().optional() }).strict().optional(),
  toolCallTimeoutMs: z.number().int().positive().optional(),
  modelResilience: z.object({ maxRetries: z.number().int().nonnegative().optional(), baseDelayMs: z.number().int().positive().optional(), maxDelayMs: z.number().int().positive().optional(), jitterMs: z.number().int().nonnegative().optional(), defaultConcurrency: z.number().int().positive().optional(), providers: z.record(z.string(), z.object({ maxRetries: z.number().int().nonnegative().optional(), baseDelayMs: z.number().int().positive().optional(), maxDelayMs: z.number().int().positive().optional(), jitterMs: z.number().int().nonnegative().optional(), concurrency: z.number().int().positive().optional() }).strict()).optional() }).strict().optional(),
}).strict();
export type ShoggothRuntimeConfig = z.infer<typeof shoggothRuntimeConfigSchema>;
