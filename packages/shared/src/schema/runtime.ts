import { z } from "zod";

export const shoggothPluginEntrySchema = z
  .object({
    id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    package: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const n = Number(Boolean(p.path)) + Number(Boolean(p.package));
    if (n !== 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "each plugin entry must specify exactly one of path or package",
      });
  });
export type ShoggothPluginEntry = z.infer<typeof shoggothPluginEntrySchema>;
export const shoggothSkillsConfigSchema = z
  .object({ scanRoots: z.array(z.string().min(1)), disabledIds: z.array(z.string().min(1)) })
  .strict();
export type ShoggothSkillsConfig = z.infer<typeof shoggothSkillsConfigSchema>;
export const DEFAULT_SKILLS_CONFIG: ShoggothSkillsConfig = {
  scanRoots: ["skills"],
  disabledIds: [],
};

export const shoggothPromptsConfigSchema = z
  .object({ globalDir: z.string().min(1).optional() })
  .strict();
export type ShoggothPromptsConfig = z.infer<typeof shoggothPromptsConfigSchema>;
/** Global canned-prompt folder; workspace `prompts/` files take precedence. */
export const DEFAULT_PROMPTS_CONFIG: ShoggothPromptsConfig = {
  globalDir: "/var/lib/shoggoth/shared/prompts",
};
export const shoggothRetentionConfigSchema = z
  .object({
    inboundMediaMaxAgeDays: z.number().int().positive().optional(),
    inboundMediaMaxTotalBytes: z.number().int().positive().optional(),
    transcriptMessageMaxAgeDays: z.number().int().positive().optional(),
    transcriptMaxMessagesPerSession: z.number().int().positive().optional(),
    kvMaxEntries: z.number().int().positive().optional(),
  })
  .strict();
export type ShoggothRetentionConfig = z.infer<typeof shoggothRetentionConfigSchema>;
export const shoggothSearxngConfigSchema = z
  .object({
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    defaultCount: z.number().int().min(1).max(20).optional(),
    defaultLanguage: z.string().optional(),
    defaultTimeRange: z.enum(["day", "week", "month", "year"]).optional(),
    engines: z.array(z.string()).optional(),
  })
  .strict();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ShoggothSearxngConfig = z.infer<typeof shoggothSearxngConfigSchema>;
export const shoggothAcpxConfigSchema = z
  .object({ binary: z.string().min(1).optional(), defaultArgs: z.array(z.string()).optional() })
  .strict();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ShoggothAcpxConfig = z.infer<typeof shoggothAcpxConfigSchema>;

const mediaGenerationAdapterType = z.enum([
  "openrouter-video",
  "openai-images",
  "openai-chat-image",
  "openai-video-async",
  "gemini-generate-content",
  "gemini-predict",
  "gemini-long-running",
]);
const mediaGenerationModelSchema = z.object({
  name: z.string().min(1),
  mediaType: z.enum(["image", "video", "audio"]),
  adapter: mediaGenerationAdapterType.optional(),
  modalities: z.array(z.string()).optional(),
});
const mediaGenerationProviderSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["openai-compatible", "gemini"]),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  apiVersion: z.string().optional(),
  models: z.array(mediaGenerationModelSchema).optional().default([]),
});
export type ShoggothMediaGenerationProvider = z.infer<typeof mediaGenerationProviderSchema>;
export type ShoggothMediaGenerationProviderBody = Omit<ShoggothMediaGenerationProvider, "id">;

/** Expand a keyed `mediaGeneration.providers` map into runtime provider entries (injecting the key as `id`). */
export function mediaGenerationProvidersToEntries(
  providers: Record<string, ShoggothMediaGenerationProviderBody> = {},
): ShoggothMediaGenerationProvider[] {
  return Object.entries(providers).map(([id, p]) => ({ id, ...p }));
}

const mediaGenerationAdapterDefaults = z.object({
  pollIntervalMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export const shoggothMediaGenerationConfigSchema = z
  .object({
    providers: z
      .record(z.string().min(1), mediaGenerationProviderSchema.omit({ id: true }))
      .optional()
      .default({}),
    adapterDefaults: z
      .record(mediaGenerationAdapterType, mediaGenerationAdapterDefaults)
      .optional(),
    outputDirectory: z.string().min(1).optional(),
  })
  .strict();
export type ShoggothMediaGenerationConfig = z.infer<typeof shoggothMediaGenerationConfigSchema>;

/**
 * Decision (classifier) model support — TypeSafe System One (`/v1/systemone`).
 * Providers serve typed `noul`, `choice`, and `score` questions against a state.
 */
const decisionModelSchema = z.object({ name: z.string().min(1) });
const decisionProviderSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["typesafe"]),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  models: z.array(decisionModelSchema).optional().default([]),
});
export type ShoggothDecisionProvider = z.infer<typeof decisionProviderSchema>;
export type ShoggothDecisionProviderBody = Omit<ShoggothDecisionProvider, "id">;

/** Expand a keyed `decision.providers` map into runtime provider entries (injecting the key as `id`). */
export function decisionProvidersToEntries(
  providers: Record<string, ShoggothDecisionProviderBody> = {},
): ShoggothDecisionProvider[] {
  return Object.entries(providers).map(([id, p]) => ({ id, ...p }));
}
export const shoggothDecisionConfigSchema = z
  .object({
    /** Model used when a request omits `model`, in `provider-id/model-name`
     * format. Must match a configured provider model. */
    defaultModel: z.string().min(1).optional(),
    providers: z
      .record(z.string().min(1), decisionProviderSchema.omit({ id: true }))
      .optional()
      .default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.defaultModel) return;
    // must reference a configured model in provider-id/model-name format
    const known = Object.entries(cfg.providers ?? {}).some(([id, p]) =>
      (p.models ?? []).some((m) => `${id}/${m.name}` === cfg.defaultModel),
    );
    if (!known) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultModel"],
        message: `defaultModel "${cfg.defaultModel}" must be a configured model in provider-id/model-name format`,
      });
    }
  });
export type ShoggothDecisionConfig = z.infer<typeof shoggothDecisionConfigSchema>;

/**
 * Rerank model support — Cohere-style rerank API (`/v1/rerank`), as served by
 * Cohere and OpenRouter's compatible endpoint. A `query` is scored against a
 * list of `documents` and results come back as `{ index, relevance_score }`
 * pairs ordered by relevance.
 */
const rerankModelSchema = z.object({ name: z.string().min(1) });
const rerankProviderSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["cohere"]),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  models: z.array(rerankModelSchema).optional().default([]),
});
export type ShoggothRerankProvider = z.infer<typeof rerankProviderSchema>;
export type ShoggothRerankProviderBody = Omit<ShoggothRerankProvider, "id">;

/** Expand a keyed `rerank.providers` map into runtime provider entries (injecting the key as `id`). */
export function rerankProvidersToEntries(
  providers: Record<string, ShoggothRerankProviderBody> = {},
): ShoggothRerankProvider[] {
  return Object.entries(providers).map(([id, p]) => ({ id, ...p }));
}
export const shoggothRerankConfigSchema = z
  .object({
    /** Model used when a request omits `model`, in `provider-id/model-name`
     * format. Must match a configured provider model. */
    defaultModel: z.string().min(1).optional(),
    /** Automatic rerank of memory-search hits (RAG integration). On by
     * default when `defaultModel` is configured; set `enabled: false` to
     * opt out. Gates only the memory-search rerank step — the
     * builtin-rerank tool and the rerank_documents op stay gated on
     * providers+models being configured. */
    memorySearch: z
      .object({
        /** Defaults to true: when `defaultModel` is also configured,
         * memory-search re-scores and re-orders its retrieved hits
         * automatically. Set to false to keep plain retrieval order. */
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional(),
    providers: z
      .record(z.string().min(1), rerankProviderSchema.omit({ id: true }))
      .optional()
      .default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.defaultModel) return;
    // must reference a configured model in provider-id/model-name format
    const known = Object.entries(cfg.providers ?? {}).some(([id, p]) =>
      (p.models ?? []).some((m) => `${id}/${m.name}` === cfg.defaultModel),
    );
    if (!known) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultModel"],
        message: `defaultModel "${cfg.defaultModel}" must be a configured model in provider-id/model-name format`,
      });
    }
  });
export type ShoggothRerankConfig = z.infer<typeof shoggothRerankConfigSchema>;

export const shoggothRuntimeConfigSchema = z
  .object({
    agentId: z
      .string()
      .min(1)
      .refine((s) => !s.includes(":"), "must not contain ':'")
      .optional(),
    drainTimeoutMs: z.number().int().positive().optional(),
    bootStaleClaimMs: z.number().int().nonnegative().optional(),
    heartbeatIntervalMs: z.number().int().positive().optional(),
    cronTickIntervalMs: z.number().int().positive().optional(),
    heartbeatBatchSize: z.number().int().positive().optional(),
    heartbeatConcurrency: z.number().int().positive().optional(),
    retentionScheduleIntervalMs: z.number().int().nonnegative().optional(),
    configHotReload: z.boolean().optional(),
    mcpLogServerMessages: z.boolean().optional(),
    openaiBaseUrl: z.string().min(1).optional(),
    ollamaHost: z.string().min(1).optional(),
    suppressContextWindowMismatchNotice: z.boolean().optional(),
    minimalContext: z
      .object({ transcriptTailMessages: z.number().int().nonnegative().optional() })
      .strict()
      .optional(),
    turnQueue: z
      .object({
        starvationThreshold: z.number().int().positive().optional(),
        maxDepth: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    toolCallTimeoutMs: z.number().int().positive().optional(),
    /**
     * Maximum `yieldMs` (ms) the exec tool honors before backgrounding the
     * process. Requested values above the cap are clamped. Default: 30000
     * (30 seconds; see DEFAULT_EXEC_MAX_YIELD_MS).
     */
    execMaxYieldMs: z.number().int().positive().optional(),
    /**
     * How long (ms) a `builtin-session-send` call blocks waiting for the
     * target's reply before yielding and registering a notify handle. `0`
     * disables yielding (block until the reply arrives). Default: 30000
     * (30 seconds; see DEFAULT_SESSION_SEND_YIELD_MS).
     */
    sessionSendYieldMs: z.number().int().nonnegative().optional(),
    /**
     * Maximum TTL (ms) enforced wherever the system controls a process lifetime
     * (subagent inactivity windows, workflow task runtime limits / wait timeouts,
     * tool-call execution timeouts). Used both as the default when a TTL is
     * unspecified and as the cap for provided TTLs — an absent TTL never means
     * "forever". Default: 24 hours (86_400_000).
     */
    maxTtlMs: z.number().int().positive().optional(),
    modelResilience: z
      .object({
        maxRetries: z.number().int().nonnegative().optional(),
        baseDelayMs: z.number().int().positive().optional(),
        maxDelayMs: z.number().int().positive().optional(),
        jitterMs: z.number().int().nonnegative().optional(),
        defaultConcurrency: z.number().int().positive().optional(),
        providers: z
          .record(
            z.string(),
            z
              .object({
                maxRetries: z.number().int().nonnegative().optional(),
                baseDelayMs: z.number().int().positive().optional(),
                maxDelayMs: z.number().int().positive().optional(),
                jitterMs: z.number().int().nonnegative().optional(),
                concurrency: z.number().int().positive().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ShoggothRuntimeConfig = z.infer<typeof shoggothRuntimeConfigSchema>;
