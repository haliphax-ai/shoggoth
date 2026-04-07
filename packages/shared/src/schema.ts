import { z } from "zod";
import { LAYOUT } from "./paths";

// ---------------------------------------------------------------------------
// Context Levels
// ---------------------------------------------------------------------------

export const CONTEXT_LEVELS = ["none", "minimal", "light", "full"] as const;

export const contextLevelSchema = z.enum(CONTEXT_LEVELS);

export type ContextLevel = z.infer<typeof contextLevelSchema>;

export const THINKING_DISPLAY_MODES = ["full", "indicator", "none"] as const;

export const thinkingDisplaySchema = z.enum(THINKING_DISPLAY_MODES);

export type ThinkingDisplay = z.infer<typeof thinkingDisplaySchema>;

export const contextLevelToolOverrideSchema = z
  .object({
    /** Additional tools to allow at this level (added to defaults). */
    allow: z.array(z.string().min(1)).optional(),
    /** Additional tools to exclude at this level (added to defaults). */
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ContextLevelToolOverride = z.infer<typeof contextLevelToolOverrideSchema>;

export const contextLevelToolsConfigSchema = z
  .object({
    none: contextLevelToolOverrideSchema.optional(),
    minimal: contextLevelToolOverrideSchema.optional(),
    light: contextLevelToolOverrideSchema.optional(),
    full: contextLevelToolOverrideSchema.optional(),
  })
  .strict();

const shoggothOpenAiCompatibleProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("openai-compatible"),
    baseUrl: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    /** When true, pass image URLs directly to the provider instead of fetching and base64-encoding. Only effective when the provider supports URL-based image sources. Default false. */
    imageUrlPassthrough: z.boolean().optional(),
  })
  .strict();

const shoggothAnthropicMessagesProviderSchema = z
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
  })
  .strict();

const shoggothGeminiProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("gemini"),
    /** API origin, e.g. "https://generativelanguage.googleapis.com". Defaults in provider factory when omitted. */
    baseUrl: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    /** API version path segment (default "v1beta"). */
    apiVersion: z.string().min(1).optional(),
  })
  .strict();

const shoggothModelProviderEntrySchema = z.discriminatedUnion("kind", [
  shoggothOpenAiCompatibleProviderSchema,
  shoggothAnthropicMessagesProviderSchema,
  shoggothGeminiProviderSchema,
]);

type ShoggothModelProviderEntry = z.infer<typeof shoggothModelProviderEntrySchema>;

const shoggothModelThinkingSchema = z
  .object({
    enabled: z.boolean(),
    budgetTokens: z.number().int().positive().optional(),
  })
  .strict();

const shoggothModelDefaultInvocationSchema = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    thinking: shoggothModelThinkingSchema.optional(),
    reasoningEffort: z.string().min(1).optional(),
    requestExtras: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const shoggothModelFailoverHopSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    contextWindowTokens: z.number().int().positive().optional(),
    thinkingFormat: z.enum(["native", "xml-tags", "none"]).optional(),
    capabilities: z.object({
      imageInput: z.boolean().optional(),
      thinkingFormat: z.enum(["native", "xml-tags", "none"]).optional(),
    }).strict().optional(),
  })
  .strict();

export type ShoggothModelFailoverHop = z.infer<typeof shoggothModelFailoverHopSchema>;

export const shoggothModelsCompactionSchema = z
  .object({
    maxContextChars: z.number().int().positive(),
    preserveRecentMessages: z.number().int().nonnegative(),
    summaryMaxOutputTokens: z.number().int().positive().optional(),
    /** Trigger inline compaction when estimated token usage exceeds (contextWindow − reserveTokens). Default 20 000. */
    contextWindowReserveTokens: z.number().int().positive().optional(),
    /** Maximum time (ms) to wait for compaction to complete before honoring an abort. Default 60000 (60s). */
    compactionAbortTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export type ShoggothModelsCompaction = z.infer<typeof shoggothModelsCompactionSchema>;

const shoggothModelsCompactionPartialSchema = shoggothModelsCompactionSchema.partial();

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
    failoverChain: z.array(shoggothModelFailoverHopSchema).optional(),
    /** Default model call parameters; per-session `model_selection` JSON overrides by field. */
    defaultInvocation: shoggothModelDefaultInvocationSchema.optional(),
    compaction: shoggothModelsCompactionSchema.optional(),
  })
  .strict();

export type ShoggothModelsConfig = z.infer<typeof shoggothModelsConfigSchema>;

/** Data lifecycle: inbound media on disk and transcript rows in SQLite. Unset fields disable that rule. */
export const shoggothRetentionConfigSchema = z
  .object({
    /** Delete inbound media files older than this many days (mtime). */
    inboundMediaMaxAgeDays: z.number().int().positive().optional(),
    /** After age purge, delete oldest files until total inbound size is at or below this. */
    inboundMediaMaxTotalBytes: z.number().int().positive().optional(),
    /** Delete transcript_messages rows older than this many days (`created_at`). */
    transcriptMessageMaxAgeDays: z.number().int().positive().optional(),
    /** Per session, keep only the newest N rows by `seq`; older rows deleted. */
    transcriptMaxMessagesPerSession: z.number().int().positive().optional(),
    /** Per workspace, keep only the newest N kv_store entries by updated_at; oldest evicted. */
    kvMaxEntries: z.number().int().positive().optional(),
  })
  .strict();

export type ShoggothRetentionConfig = z.infer<typeof shoggothRetentionConfigSchema>;

const shoggothReactionsConfigSchema = z.object({
  globalPassthrough: z.array(z.string().min(1)).optional(),
  maxAgeMinutes: z.number().int().positive().optional(),
}).strict();
type ShoggothReactionsConfig = z.infer<typeof shoggothReactionsConfigSchema>;

export const hitlRiskTierSchema = z.enum(["safe", "caution", "critical", "never"]);

export type HitlRiskTier = z.infer<typeof hitlRiskTierSchema>;

export const shoggothHitlConfigSchema = z
  .object({
    defaultApprovalTimeoutMs: z.number().int().positive(),
    toolRisk: z.record(z.string(), hitlRiskTierSchema),
    /** Default highest tier that may run without human approval (inclusive). Per-agent overrides live in agents.list.<id>.hitl.bypassUpTo. */
    bypassUpTo: hitlRiskTierSchema,
  })
  .strict();

export type ShoggothHitlConfig = z.infer<typeof shoggothHitlConfigSchema>;

export const shoggothMemoryEmbeddingsConfigSchema = z
  .object({
    enabled: z.boolean(),
    modelId: z.string().min(1).optional(),
    /** OpenAI-compatible API origin; normalized to `/v1`. Merged into `SHOGGOTH_MEMORY_OPENAI_BASE_URL` when unset. */
    openaiBaseUrl: z.string().min(1).optional(),
    /** Bare API key value. Takes precedence over `apiKeyEnv`. */
    apiKey: z.string().min(1).optional(),
    /** Env var holding the API key (default `OPENAI_API_KEY`). */
    apiKeyEnv: z.string().min(1).optional(),
  })
  .strict();

export type ShoggothMemoryEmbeddingsConfig = z.infer<typeof shoggothMemoryEmbeddingsConfigSchema>;

export const shoggothMemoryConfigSchema = z
  .object({
    /** Absolute or workspace-relative roots scanned recursively for `*.md`. */
    paths: z.array(z.string().min(1)),
    embeddings: shoggothMemoryEmbeddingsConfigSchema,
  })
  .strict();

export type ShoggothMemoryConfig = z.infer<typeof shoggothMemoryConfigSchema>;

/** Per-principal allow/deny lists for tools or control ops. Deny wins; empty allow + no `*` → default-deny. */
export const shoggothToolRulesSchema = z
  .object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    review: z.array(z.string()).default([]),
  })
  .strict();

export type ShoggothToolRules = z.infer<typeof shoggothToolRulesSchema>;

export const shoggothPolicyConfigSchema = z
  .object({
    operator: z
      .object({
        controlOps: shoggothToolRulesSchema,
        tools: shoggothToolRulesSchema,
      })
      .strict(),
    agent: z
      .object({
        controlOps: shoggothToolRulesSchema,
        tools: shoggothToolRulesSchema,
      })
      .strict(),
    auditRedaction: z
      .object({
        /** Dot paths into JSON objects (e.g. `env.API_KEY`, `headers.authorization`). */
        jsonPaths: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type ShoggothPolicyConfig = z.infer<typeof shoggothPolicyConfigSchema>;

/** Layered JSON fragments may supply partial policy overlays. */
export const shoggothPolicyFragmentSchema = z
  .object({
    operator: z
      .object({
        controlOps: shoggothToolRulesSchema.partial().optional(),
        tools: shoggothToolRulesSchema.partial().optional(),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        controlOps: shoggothToolRulesSchema.partial().optional(),
        tools: shoggothToolRulesSchema.partial().optional(),
      })
      .strict()
      .optional(),
    auditRedaction: z
      .object({
        jsonPaths: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export type ShoggothPolicyFragment = z.infer<typeof shoggothPolicyFragmentSchema>;

export const DEFAULT_POLICY_CONFIG: ShoggothPolicyConfig = {
  operator: {
    controlOps: {
      allow: ["*"],
      deny: [],
      review: [],
    },
    tools: { allow: ["*"], deny: [], review: [] },
  },
  agent: {
    controlOps: {
      allow: [
        "agent_ping",
        "acpx_bind_get",
        "subagent_spawn",
        "subagent_result",
        "subagent_wait",
        "session_compact",
        "session_context_status",
        "session_inspect",
        "session_list",
        "session_stats",
        "session_send",
        "session_steer",
        "session_abort",
        "session_kill",
        "config_request",
        "config_show",
      ],
      deny: [],
      review: [],
    },
    tools: { allow: ["*"], deny: [], review: [] },
  },
  auditRedaction: {
    jsonPaths: ["password", "token", "apiKey", "api_key", "authorization", "secret"],
  },
};

export const DEFAULT_MEMORY_CONFIG: ShoggothMemoryConfig = {
  paths: [],
  embeddings: { enabled: false },
};

/** Default tool call timeout: 10 minutes. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 600_000;

export const shoggothPluginEntrySchema = z
  .object({
    id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    package: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const n = Number(Boolean(p.path)) + Number(Boolean(p.package));
    if (n !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "each plugin entry must specify exactly one of path or package",
      });
    }
  });

export type ShoggothPluginEntry = z.infer<typeof shoggothPluginEntrySchema>;

export const shoggothSkillsConfigSchema = z
  .object({
    /** Directories scanned recursively for `*.md` skill files. */
    scanRoots: z.array(z.string().min(1)),
    disabledIds: z.array(z.string().min(1)),
  })
  .strict();

export type ShoggothSkillsConfig = z.infer<typeof shoggothSkillsConfigSchema>;

const mcpSourceIdSchema = z
  .string()
  .min(1)
  .refine((s) => !s.includes("."), { message: "MCP server id must not contain '.' (used as source id)" });

/** Per-server override for MCP connection pooling (omit or `inherit` → use top-level `mcp.poolScope`). */
export const shoggothMcpServerPoolScopeSchema = z.enum(["inherit", "global", "per_session"]);

export type ShoggothMcpServerPoolScope = z.infer<typeof shoggothMcpServerPoolScopeSchema>;

export const shoggothMcpStdioServerSchema = z
  .object({
    id: mcpSourceIdSchema,
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
    poolScope: shoggothMcpServerPoolScopeSchema.optional(),
  })
  .strict();

export const shoggothMcpTcpServerSchema = z
  .object({
    id: mcpSourceIdSchema,
    transport: z.literal("tcp"),
    host: z.string().min(1),
    port: z.number().int().positive(),
    poolScope: shoggothMcpServerPoolScopeSchema.optional(),
  })
  .strict();

/** MCP Streamable HTTP (POST + optional SSE) per spec 2025-11-25. */
export const shoggothMcpHttpServerSchema = z
  .object({
    id: mcpSourceIdSchema,
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    poolScope: shoggothMcpServerPoolScopeSchema.optional(),
  })
  .strict();

export const shoggothMcpServerEntrySchema = z.discriminatedUnion("transport", [
  shoggothMcpStdioServerSchema,
  shoggothMcpTcpServerSchema,
  shoggothMcpHttpServerSchema,
]);

export type ShoggothMcpServerEntry = z.infer<typeof shoggothMcpServerEntrySchema>;

export type ShoggothMcpHttpServerEntry = z.infer<typeof shoggothMcpHttpServerSchema>;

/** Default idle eviction for lazy per-session MCP pools when `perSessionIdleTimeoutMs` is omitted. */
export const SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS = 30 * 60 * 1000;

export const shoggothMcpConfigSchema = z
  .object({
    servers: z.array(shoggothMcpServerEntrySchema),
    /**
     * Default for servers that omit `poolScope` or set `poolScope: "inherit"`.
     * `global`: one MCP connection set shared across all platform-bound sessions.
     * `per_session`: lazy pool per Shoggoth `sessionId` on first inbound turn; closed on orchestrator stop.
     */
    poolScope: z.enum(["global", "per_session"]).default("global"),
    /**
     * After an inbound platform turn completes, close that session's per-session MCP pool if no further
     * turn completes within this many milliseconds. `0` disables. When omitted and any server uses an
     * effective per-session pool, defaults to {@link SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS}.
     */
    perSessionIdleTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ShoggothMcpConfig = z.infer<typeof shoggothMcpConfigSchema>;

/** Optional defaults for `acpx_agent_start` when payload omits `acpx_args`. */
const shoggothAcpxConfigSchema = z
  .object({
    /** Path or name resolved on `PATH` (default `acpx`). */
    binary: z.string().min(1).optional(),
    /** Argv after the binary when the control op does not pass `acpx_args`. */
    defaultArgs: z.array(z.string()).optional(),
  })
  .strict();

type ShoggothAcpxConfig = z.infer<typeof shoggothAcpxConfigSchema>;

/**
 * Common platform config fields validated by core. Platform-specific extension fields pass through
 * via `.passthrough()` and are validated separately by the platform plugin.
 */
export const platformCommonConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    routes: z.unknown().optional(),
    streamResponses: z.boolean().optional(),
    streamMinIntervalMs: z.number().optional(),
    appendModelTagFooter: z.boolean().optional(),
    hitlReplyInSession: z.boolean().optional(),
  })
  .passthrough();

/** Daemon timers, probes, and feature flags also available via `SHOGGOTH_*` env (env wins when set). */
export const shoggothRuntimeConfigSchema = z
  .object({
    /**
     * Logical agent id embedded in session URNs (`agent:<agentId>:…`). Must not contain `:`.
     * Env override: `SHOGGOTH_AGENT_ID`.
     */
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
    /** When false, in-process config hot-reload is disabled unless `SHOGGOTH_CONFIG_HOT_RELOAD=0` already disables. */
    configHotReload: z.boolean().optional(),
    mcpLogServerMessages: z.boolean().optional(),
    openaiBaseUrl: z.string().min(1).optional(),
    ollamaHost: z.string().min(1).optional(),
    /** When true, suppress the platform-surfaced context window mismatch notice (stderr log still fires). */
    suppressContextWindowMismatchNotice: z.boolean().optional(),
    minimalContext: z.object({
      transcriptTailMessages: z.number().int().nonnegative().optional(),
    }).strict().optional(),
    turnQueue: z
      .object({
        starvationThreshold: z.number().int().positive().optional(),
        maxDepth: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** Maximum milliseconds a single tool call may run before being killed. Default 600_000 (10 min). Env override: `SHOGGOTH_TOOL_CALL_TIMEOUT_MS`. */
    toolCallTimeoutMs: z.number().int().positive().optional(),
    /** Global and per-provider resilience settings (retry, backoff, concurrency). */
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

/**
 * Cross-agent `session_send` allowlists. Omitted → agents may only target sessions with the same
 * logical agent id as the caller. `allow` entries name **target** agent ids; `"*"` allows any other agent.
 */
export const shoggothAgentToAgentAllowSchema = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const shoggothAgentToAgentConfigSchema = z
  .object({
    /** Default target allowlist merged into every sender's effective list (with `agents.list.<id>.agentToAgent.allow`). */
    allow: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ShoggothAgentToAgentConfig = z.infer<typeof shoggothAgentToAgentConfigSchema>;

/**
 * Per-agent `sessionQuery` block: which other agent ids this agent may query transcripts for.
 * Own agent id is always implicitly allowed.
 */
export const shoggothSessionQueryAllowSchema = z
  .object({
    allowedAgentIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Global `sessionQuery` config: default allowed agent ids merged into every agent's effective list.
 */
export const shoggothSessionQueryConfigSchema = z
  .object({
    allowedAgentIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ShoggothSessionQueryConfig = z.infer<typeof shoggothSessionQueryConfigSchema>;

/**
 * Which logical agent ids subagent sessions may be spawned for (merged global + `agents.list.<senderId>`),
 * i.e. the child inherits this agent id from the parent URN. Use `"*"` to allow any id for that sender.
 * If this block is absent both globally and on the sender’s `agents.list` entry, only that sender’s own
 * agent id is allowed (implicit `[sender]`).
 */
export const shoggothSubagentSpawnAllowSchema = z
  .object({
    allow: z.array(z.string().min(1)),
  })
  .strict();

export type ShoggothSubagentSpawnAllowConfig = z.infer<typeof shoggothSubagentSpawnAllowSchema>;

// ---------------------------------------------------------------------------
// Tool Discovery
// ---------------------------------------------------------------------------

const toolDiscoveryTriggerSchema = z
  .object({
    /** Case-insensitive substring or /regex/ pattern to match in user messages. */
    match: z.string().min(1),
    /** Tool IDs to auto-enable when matched. */
    tools: z.array(z.string().min(1)),
  })
  .strict();

export const shoggothToolDiscoveryConfigSchema = z
  .object({
    /** When true, tool discovery/collapse is active. Default: false (all tools advertised). */
    enabled: z.boolean().optional(),
    /** Tool IDs that are never collapsed (always in the tools array). */
    alwaysOn: z.array(z.string().min(1)).default([
      "builtin-read", "builtin-write", "builtin-exec", "builtin-memory-search", "builtin-session-query",
      "builtin-poll", "builtin-skills", "builtin-show", "builtin-fs", "builtin-ls", "builtin-fetch", "builtin-kv", "builtin-timer",
      "builtin-search-replace", "builtin-cd",
    ]),
    /** Trigger phrases: when a user message contains the match string (case-insensitive), the listed tool IDs are auto-enabled for that turn. */
    triggers: z.array(toolDiscoveryTriggerSchema).optional(),
  })
  .strict();

export type ShoggothToolDiscoveryConfig = z.infer<typeof shoggothToolDiscoveryConfigSchema>;

export const shoggothAgentToolDiscoveryConfigSchema = z
  .object({
    /** Per-agent always-on additions (merged with global). */
    alwaysOn: z.array(z.string().min(1)).optional(),
    /** Per-agent trigger additions (merged with global). */
    triggers: z.array(toolDiscoveryTriggerSchema).optional(),
    /** Per-agent override: set false to disable discovery for this agent even when globally enabled. */
    enabled: z.boolean().optional(),
  })
  .strict();

export type ShoggothAgentToolDiscoveryConfig = z.infer<typeof shoggothAgentToolDiscoveryConfigSchema>;

const shoggothAgentIdKeySchema = z
  .string()
  .min(1)
  .refine((s) => !s.includes(":"), "must not contain ':'");

/**
 * Per-agent block under `agents.list.<agentId>` (key is the logical agent id; matches session URN segment).
 */
export const shoggothAgentEntrySchema = z
  .object({
    /** Optional label for operators / logs; on messaging platforms, `**<emoji> <label>:**` uses this or falls back to the list key (emoji defaults to 🦑). */
    displayName: z.string().min(1).optional(),
    /** Overrides default 🦑 in the identity line before `displayName`. */
    emoji: z.string().min(1).optional(),
    models: shoggothAgentModelsOverrideSchema.optional(),
    /** Per-agent platform overrides — each key is a platform id. */
    platforms: z.record(z.string(), z.object({
      routes: z.unknown().optional(),
    }).passthrough()).optional(),
    /** Extra memory roots (merged after global `memory.paths` for this agent's sessions). */
    memory: z
      .object({
        paths: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    agentToAgent: shoggothAgentToAgentAllowSchema.optional(),
    /**
     * Merged with top-level `subagentSpawnAllow.allow` for this sender id. Restricts which logical agent
     * ids that sender may spawn subagents for. Omitted here (and globally) ⇒ only the sender’s own id.
     */
    subagentSpawnAllow: shoggothSubagentSpawnAllowSchema.optional(),
    /**
     * When false, this agent cannot use `builtin-subagent` or agent-scoped subagent control ops
     * (`subagent_spawn`, `session_inspect`, `session_steer`, `session_abort`, `session_kill`).
     * Overrides top-level `spawnSubagents` when set.
     */
    spawnSubagents: z.boolean().optional(),
    /** Which agent ids this agent may query transcripts for (merged with global `sessionQuery.allowedAgentIds`; own id always allowed). */
    sessionQuery: shoggothSessionQueryAllowSchema.optional(),
    /** Per-agent tool policy overrides (merged with global `policy.agent.tools`; per-agent fields replace global when present). */
    policy: z
      .object({
        tools: shoggothToolRulesSchema.partial().optional(),
      })
      .strict()
      .optional(),
    /** Per-agent HITL overrides. */
    hitl: z
      .object({
        /** Override the global hitl.bypassUpTo for this agent. */
        bypassUpTo: hitlRiskTierSchema.optional(),
        /** Tools that skip HITL for this agent. Platform reactions (e.g. ♾️) append here via dynamic config. */
        toolAutoApprove: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    reactions: shoggothReactionsConfigSchema.partial().optional(),
    /** Per-agent tool call timeout override (ms). When set, takes precedence over `runtime.toolCallTimeoutMs` for this agent's sessions. */
    toolCallTimeoutMs: z.number().int().positive().optional(),
    /** Context level for this agent's own sessions. */
    contextLevel: contextLevelSchema.optional(),
    /** Context level for subagents spawned by this agent. */
    subagentContextLevel: contextLevelSchema.optional(),
    /** Per-agent tool discovery overrides (merged with global `toolDiscovery`). */
    toolDiscovery: shoggothAgentToolDiscoveryConfigSchema.optional(),
    /** How to display model thinking output. Default: "none" if omitted. */
    thinkingDisplay: thinkingDisplaySchema.optional(),
  })
  .strict();

export type ShoggothAgentEntry = z.infer<typeof shoggothAgentEntrySchema>;

export const shoggothAgentsConfigSchema = z
  .object({
    /** Map of logical agent id → per-agent overrides (key must match session URN `agent:<id>:…`). */
    list: z.record(shoggothAgentIdKeySchema, shoggothAgentEntrySchema).optional(),
    /** Default context level for top-level agent sessions. Default: "full". */
    contextLevel: contextLevelSchema.optional(),
    /** Default context level for subagent sessions. Default: "light". */
    subagentContextLevel: contextLevelSchema.optional(),
    /** Use streaming for internal (non-user-facing) model calls (e.g. workflow tasks, subagents). Default: true. */
    internalStreaming: z.boolean().optional(),
  })
  .strict();

export type ShoggothAgentsConfig = z.infer<typeof shoggothAgentsConfigSchema>;

export const DEFAULT_SKILLS_CONFIG: ShoggothSkillsConfig = {
  scanRoots: [],
  disabledIds: [],
};

// ---------------------------------------------------------------------------
// Declarative sidecar process definitions (Phase 4 — procman)
// ---------------------------------------------------------------------------

const processDeclarationHealthSchema = z
  .object({
    kind: z.enum(["tcp", "http", "stdout-match"]),
    /** Port for tcp, URL for http, pattern for stdout-match. */
    target: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const processDeclarationSchema = z
  .object({
    /** Unique ID for this process (used as ProcessSpec.id). */
    id: z.string().min(1),
    /** Human-readable label. */
    label: z.string().min(1).optional(),
    /** When to start: "boot" (daemon startup) or "on-demand" (first reference). */
    startPolicy: z.enum(["boot", "on-demand"]),
    /** Command to run. */
    command: z.string().min(1),
    /** Arguments. */
    args: z.array(z.string()).optional(),
    /** Working directory. */
    cwd: z.string().min(1).optional(),
    /** Extra environment variables. */
    env: z.record(z.string()).optional(),
    /** Restart policy mode. Default "on-failure". */
    restartMode: z.enum(["never", "on-failure", "always"]).optional(),
    /** Max restart retries. Default 5. */
    maxRetries: z.number().int().nonnegative().optional(),
    /** Health check (optional). */
    health: processDeclarationHealthSchema.optional(),
  })
  .strict();

export type ProcessDeclaration = z.infer<typeof processDeclarationSchema>;

// ---------------------------------------------------------------------------
// SearXNG web search
// ---------------------------------------------------------------------------

export const shoggothSearxngConfigSchema = z
  .object({
    /** Base URL of the SearXNG instance (e.g. "http://searxng:8080") */
    baseUrl: z.string(),
    /** Optional API key */
    apiKey: z.string().optional(),
    /** Default result count (1-20, default: 5) */
    defaultCount: z.number().int().min(1).max(20).optional(),
    /** Default language (ISO 639-1) */
    defaultLanguage: z.string().optional(),
    /** Default time range */
    defaultTimeRange: z.enum(["day", "week", "month", "year"]).optional(),
    /** Engine allowlist */
    engines: z.array(z.string()).optional(),
  })
  .strict();

export type ShoggothSearxngConfig = z.infer<typeof shoggothSearxngConfigSchema>;



/** Layered JSON fragments must satisfy this shape after merge; defaults fill the rest. */
export const shoggothConfigFragmentSchema = z
  .object({
    logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
    stateDbPath: z.string().min(1).optional(),
    socketPath: z.string().min(1).optional(),
    /** Octal mode for the control socket after bind (e.g. 0o600 or 416 decimal). Default 0o600. */
    controlSocketMode: z.number().int().optional(),
    /** If both uid and gid are set, `chown` the socket after listen (requires privileges when not self). */
    controlSocketUid: z.number().int().nonnegative().optional(),
    controlSocketGid: z.number().int().nonnegative().optional(),
    /** Optional operator token file (trimmed); same constant-time validation as `SHOGGOTH_OPERATOR_TOKEN`. */
    operatorTokenPath: z.string().min(1).optional(),
    workspacesRoot: z.string().min(1).optional(),
    secretsDirectory: z.string().min(1).optional(),
    inboundMediaRoot: z.string().min(1).optional(),
    /**
     * Operator-only directory (default {@link LAYOUT.operatorDir}). Host global instructions are read from here.
     */
    operatorDirectory: z.string().min(1).optional(),
    /**
     * Absolute or operator-relative path to global instructions. Resolved file must lie under the
     * resolved `operatorDirectory`. Default: `{operatorDirectory}/GLOBAL.md`.
     */
    globalInstructionsPath: z.string().min(1).optional(),
    configDirectory: z.string().min(1).optional(),
    models: shoggothModelsConfigSchema.optional(),
    hitl: shoggothHitlConfigSchema.partial().optional(),
    memory: z
      .object({
        paths: z.array(z.string().min(1)).optional(),
        embeddings: shoggothMemoryEmbeddingsConfigSchema.partial().optional(),
      })
      .strict()
      .optional(),
    skills: z
      .object({
        scanRoots: z.array(z.string().min(1)).optional(),
        disabledIds: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    plugins: z.array(shoggothPluginEntrySchema).optional(),
    retention: shoggothRetentionConfigSchema.optional(),
    reactions: shoggothReactionsConfigSchema.partial().optional(),
    mcp: shoggothMcpConfigSchema.optional(),
    acpx: shoggothAcpxConfigSchema.partial().optional(),
    /** Generic platforms bag — each key is a platform id with common fields validated by core. */
    platforms: z.record(z.string(), platformCommonConfigSchema).optional(),
    runtime: shoggothRuntimeConfigSchema.optional(),
    agents: shoggothAgentsConfigSchema.optional(),
    agentToAgent: shoggothAgentToAgentConfigSchema.optional(),
    /**
     * Default for all agents unless overridden by `agents.list.<id>.spawnSubagents`.
     * When false, agents cannot use subagent tools / related control ops (operators unaffected).
     */
    spawnSubagents: z.boolean().optional(),
    /**
     * Default allowlist of logical agent ids subagents may be spawned for, merged with per-agent
     * `agents.list.<id>.subagentSpawnAllow.allow`. Omitted everywhere for a sender ⇒ only that sender’s own id.
     */
    subagentSpawnAllow: shoggothSubagentSpawnAllowSchema.optional(),
    /** Global session query access control: agent ids any agent may query transcripts for. */
    sessionQuery: shoggothSessionQueryConfigSchema.optional(),
    policy: shoggothPolicyFragmentSchema,
    /** Override default tool availability per context level. */
    contextLevelTools: contextLevelToolsConfigSchema.optional(),
    /** Declarative sidecar process definitions managed by procman. */
    processes: z.array(processDeclarationSchema).optional(),
    /** Daemon-writable directory for agent-requested config overrides. */
    dynamicConfigDirectory: z.string().min(1).optional(),
    /** SearXNG web search integration. */
    searxng: shoggothSearxngConfigSchema.optional(),
    /** Dynamic tool discovery / collapse configuration. */
    toolDiscovery: shoggothToolDiscoveryConfigSchema.optional(),
    /** How to display model thinking output. Default: "none" if omitted. */
    thinkingDisplay: thinkingDisplaySchema.optional(),
  })
  .strict();

export type ShoggothConfigFragment = z.infer<typeof shoggothConfigFragmentSchema>;

export const shoggothConfigSchema = z
  .object({
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    stateDbPath: z.string().min(1),
    socketPath: z.string().min(1),
    controlSocketMode: z.number().int().optional(),
    controlSocketUid: z.number().int().nonnegative().optional(),
    controlSocketGid: z.number().int().nonnegative().optional(),
    operatorTokenPath: z.string().min(1).optional(),
    workspacesRoot: z.string().min(1),
    secretsDirectory: z.string().min(1),
    inboundMediaRoot: z.string().min(1),
    operatorDirectory: z.string().min(1),
    globalInstructionsPath: z.string().min(1).optional(),
    configDirectory: z.string(),
    models: shoggothModelsConfigSchema.optional(),
    hitl: shoggothHitlConfigSchema,
    memory: shoggothMemoryConfigSchema,
    skills: shoggothSkillsConfigSchema,
    plugins: z.array(shoggothPluginEntrySchema),
    retention: shoggothRetentionConfigSchema.optional(),
    reactions: shoggothReactionsConfigSchema.optional(),
    mcp: shoggothMcpConfigSchema,
    acpx: shoggothAcpxConfigSchema.optional(),
    /** Generic platforms bag — each key is a platform id with common fields validated by core. */
    platforms: z.record(z.string(), platformCommonConfigSchema).optional(),
    runtime: shoggothRuntimeConfigSchema.optional(),
    agents: shoggothAgentsConfigSchema.optional(),
    agentToAgent: shoggothAgentToAgentConfigSchema.optional(),
    spawnSubagents: z.boolean().optional(),
    subagentSpawnAllow: shoggothSubagentSpawnAllowSchema.optional(),
    sessionQuery: shoggothSessionQueryConfigSchema.optional(),
    policy: shoggothPolicyConfigSchema,
    /** Override default tool availability per context level. */
    contextLevelTools: contextLevelToolsConfigSchema.optional(),
    /** Declarative sidecar process definitions managed by procman. */
    processes: z.array(processDeclarationSchema).optional(),
    /** Daemon-writable directory for agent-requested config overrides. */
    dynamicConfigDirectory: z.string().min(1).optional(),
    /** SearXNG web search integration. */
    searxng: shoggothSearxngConfigSchema.optional(),
    /** Dynamic tool discovery / collapse configuration. */
    toolDiscovery: shoggothToolDiscoveryConfigSchema.optional(),
    /** How to display model thinking output. Default: "none" if omitted. */
    thinkingDisplay: thinkingDisplaySchema.optional(),
  })
  .strict();

export type ShoggothConfig = z.infer<typeof shoggothConfigSchema>;

export const DEFAULT_HITL_CONFIG: ShoggothHitlConfig = {
  defaultApprovalTimeoutMs: 300_000,
  toolRisk: {
    "builtin-read": "safe",
    "builtin-write": "caution",
    "builtin-exec": "critical",
    "builtin-memory-search": "safe",
    "builtin-memory-ingest": "caution",
    "builtin-session-list": "safe",
    "builtin-session-send": "caution",
    "builtin-session-query": "safe",
    "builtin-subagent": "caution",
    "builtin-message": "caution",
    "builtin-config-request": "never",
  },
  /**
   * Default bypass tier for all agents. Per-agent overrides in agents.list.<id>.hitl.bypassUpTo.
   */
  bypassUpTo: "safe",
};

export function defaultConfig(configDirectory: string): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: LAYOUT.stateDbFile,
    socketPath: LAYOUT.controlSocket,
    workspacesRoot: LAYOUT.workspacesRoot,
    secretsDirectory: LAYOUT.secretsDir,
    inboundMediaRoot: LAYOUT.inboundMediaRoot,
    operatorDirectory: LAYOUT.operatorDir,
    configDirectory,
    dynamicConfigDirectory: "/etc/shoggoth/config.d/dynamic",
    hitl: DEFAULT_HITL_CONFIG,
    memory: DEFAULT_MEMORY_CONFIG,
    skills: DEFAULT_SKILLS_CONFIG,
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
    platforms: { discord: { enabled: true } },
  };
}
