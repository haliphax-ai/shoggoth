import { z } from "zod";
import { LAYOUT } from "./paths";

const shoggothOpenAiCompatibleProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("openai-compatible"),
    baseUrl: z.string().min(1),
    apiKeyEnv: z.string().min(1).optional(),
  })
  .strict();

const shoggothAnthropicMessagesProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("anthropic-messages"),
    /** API origin (or URL whose origin is used); POST `{origin}/v1/messages`. */
    baseUrl: z.string().min(1),
    apiKeyEnv: z.string().min(1).optional(),
    anthropicVersion: z.string().min(1).optional(),
    /** Default `x-api-key`; `bearer` sets `Authorization: Bearer`. */
    auth: z.enum(["x-api-key", "bearer"]).optional(),
  })
  .strict();

export const shoggothModelProviderEntrySchema = z.discriminatedUnion("kind", [
  shoggothOpenAiCompatibleProviderSchema,
  shoggothAnthropicMessagesProviderSchema,
]);

export type ShoggothModelProviderEntry = z.infer<typeof shoggothModelProviderEntrySchema>;

export const shoggothModelsConfigSchema = z
  .object({
    providers: z.array(shoggothModelProviderEntrySchema).optional(),
    failoverChain: z
      .array(
        z
          .object({
            providerId: z.string().min(1),
            model: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    compaction: z
      .object({
        maxContextChars: z.number().int().positive(),
        preserveRecentMessages: z.number().int().nonnegative(),
        summaryMaxOutputTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
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
  })
  .strict();

export type ShoggothRetentionConfig = z.infer<typeof shoggothRetentionConfigSchema>;

export const hitlRiskTierSchema = z.enum(["safe", "caution", "critical"]);

export type HitlRiskTier = z.infer<typeof hitlRiskTierSchema>;

export const shoggothHitlConfigSchema = z
  .object({
    defaultApprovalTimeoutMs: z.number().int().positive(),
    toolRisk: z.record(z.string(), hitlRiskTierSchema),
    /** Role id → highest tier that may run without human approval (inclusive). */
    roleBypassUpTo: z.record(z.string(), hitlRiskTierSchema),
  })
  .strict();

export type ShoggothHitlConfig = z.infer<typeof shoggothHitlConfigSchema>;

export const shoggothMemoryEmbeddingsConfigSchema = z
  .object({
    enabled: z.boolean(),
    modelId: z.string().min(1).optional(),
    /** OpenAI-compatible API origin; normalized to `/v1`. Merged into `SHOGGOTH_MEMORY_OPENAI_BASE_URL` when unset. */
    openaiBaseUrl: z.string().min(1).optional(),
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

const operatorMapEntrySchema = z
  .object({
    operatorId: z.string().min(1),
    roles: z.array(z.string()).default([]),
  })
  .strict();

/** Layered operator UID map (merged with later JSON files); combined with DB `operator_uid_map` in the daemon. */
export const shoggothOperatorMapLayerSchema = z
  .object({
    defaultOperator: operatorMapEntrySchema.optional(),
    byUid: z.record(z.string(), operatorMapEntrySchema).optional(),
  })
  .strict();

export type ShoggothOperatorMapLayer = z.infer<typeof shoggothOperatorMapLayerSchema>;

/** Per-principal allow/deny lists for tools or control ops. Deny wins; empty allow + no `*` → default-deny. */
export const shoggothToolRulesSchema = z
  .object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
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
      allow: [
        "ping",
        "version",
        "health",
        "acpx_bind_get",
        "acpx_bind_set",
        "acpx_bind_delete",
        "acpx_bind_list",
        "acpx_agent_start",
        "acpx_agent_stop",
        "acpx_agent_list",
        "canvas_authorize",
        "hitl_pending_list",
        "hitl_pending_get",
        "hitl_pending_approve",
        "hitl_pending_deny",
        "mcp_http_cancel_request",
      ],
      deny: [],
    },
    tools: { allow: ["*"], deny: [] },
  },
  agent: {
    controlOps: {
      allow: ["agent_ping", "acpx_bind_get", "canvas_authorize"],
      deny: [],
    },
    tools: { allow: ["*"], deny: [] },
  },
  auditRedaction: {
    jsonPaths: ["password", "token", "apiKey", "api_key", "authorization", "secret"],
  },
};

export const DEFAULT_MEMORY_CONFIG: ShoggothMemoryConfig = {
  paths: [],
  embeddings: { enabled: false },
};

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
     * `global`: one MCP connection set for the whole Discord platform (legacy).
     * `per_session`: lazy pool per Shoggoth `sessionId` on first inbound turn; closed on orchestrator stop.
     */
    poolScope: z.enum(["global", "per_session"]).default("global"),
    /**
     * After an inbound Discord turn completes, close that session's per-session MCP pool if no further
     * turn completes within this many milliseconds. `0` disables. When omitted and any server uses an
     * effective per-session pool, defaults to {@link SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS}.
     */
    perSessionIdleTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ShoggothMcpConfig = z.infer<typeof shoggothMcpConfigSchema>;

/** Optional defaults for `acpx_agent_start` when payload omits `acpx_args`. */
export const shoggothAcpxConfigSchema = z
  .object({
    /** Path or name resolved on `PATH` (default `acpx`). */
    binary: z.string().min(1).optional(),
    /** Argv after the binary when the control op does not pass `acpx_args`. */
    defaultArgs: z.array(z.string()).optional(),
  })
  .strict();

export type ShoggothAcpxConfig = z.infer<typeof shoggothAcpxConfigSchema>;

/**
 * Discord bridge + assistant toggles. Env vars with the same meaning still work and **override**
 * these fields when set (non-empty for strings; `0`/`1` for booleans where documented).
 */
export const shoggothDiscordConfigSchema = z
  .object({
    botToken: z.string().min(1).optional(),
    /** Gateway intents decimal; same as `SHOGGOTH_DISCORD_INTENTS`. */
    intents: z.number().int().optional(),
    /** Same JSON string as `SHOGGOTH_DISCORD_ROUTES` (array of route objects). */
    routesJson: z.string().min(1).optional(),
    allowBotMessages: z.boolean().optional(),
    streamResponses: z.boolean().optional(),
    streamMinIntervalMs: z.number().int().nonnegative().optional(),
    appendModelTagFooter: z.boolean().optional(),
    hitlNotifyChannelId: z.string().min(1).optional(),
    hitlNotifyWebhookUrl: z.string().min(1).optional(),
    /** Discord user snowflake; daemon opens a DM via REST and posts HITL notices there. */
    hitlNotifyDmUserId: z.string().min(1).optional(),
    /**
     * When true (default), post a HITL notice as a reply in the routed session channel. Set false or
     * `SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION=0` to rely on DM / operator channel / webhook only.
     */
    hitlReplyInSession: z.boolean().optional(),
  })
  .strict();

export type ShoggothDiscordConfig = z.infer<typeof shoggothDiscordConfigSchema>;

/** Daemon timers, probes, and feature flags also available via `SHOGGOTH_*` env (env wins when set). */
export const shoggothRuntimeConfigSchema = z
  .object({
    drainTimeoutMs: z.number().int().positive().optional(),
    bootStaleClaimMs: z.number().int().nonnegative().optional(),
    heartbeatIntervalMs: z.number().int().positive().optional(),
    cronTickIntervalMs: z.number().int().positive().optional(),
    heartbeatBatchSize: z.number().int().positive().optional(),
    heartbeatConcurrency: z.number().int().positive().optional(),
    transcriptAutoCompactIntervalMs: z.number().int().nonnegative().optional(),
    retentionScheduleIntervalMs: z.number().int().nonnegative().optional(),
    /** When false, in-process config hot-reload is disabled unless `SHOGGOTH_CONFIG_HOT_RELOAD=0` already disables. */
    configHotReload: z.boolean().optional(),
    mcpLogServerMessages: z.boolean().optional(),
    openaiBaseUrl: z.string().min(1).optional(),
    ollamaHost: z.string().min(1).optional(),
  })
  .strict();

export type ShoggothRuntimeConfig = z.infer<typeof shoggothRuntimeConfigSchema>;

export const DEFAULT_SKILLS_CONFIG: ShoggothSkillsConfig = {
  scanRoots: [],
  disabledIds: [],
};

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
    /** JSON operator UID map file; chained after DB and layered `operatorMap`. */
    operatorMapPath: z.string().min(1).optional(),
    /** Optional operator token file (trimmed); same constant-time validation as `SHOGGOTH_OPERATOR_TOKEN`. */
    operatorTokenPath: z.string().min(1).optional(),
    /** Layered operator UID entries + default (deep-merged across config fragments). */
    operatorMap: shoggothOperatorMapLayerSchema.optional(),
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
    mcp: shoggothMcpConfigSchema.optional(),
    acpx: shoggothAcpxConfigSchema.partial().optional(),
    discord: shoggothDiscordConfigSchema.optional(),
    runtime: shoggothRuntimeConfigSchema.optional(),
    policy: shoggothPolicyFragmentSchema,
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
    operatorMapPath: z.string().min(1).optional(),
    operatorTokenPath: z.string().min(1).optional(),
    operatorMap: shoggothOperatorMapLayerSchema.optional(),
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
    mcp: shoggothMcpConfigSchema,
    acpx: shoggothAcpxConfigSchema.optional(),
    discord: shoggothDiscordConfigSchema.optional(),
    runtime: shoggothRuntimeConfigSchema.optional(),
    policy: shoggothPolicyConfigSchema,
  })
  .strict();

export type ShoggothConfig = z.infer<typeof shoggothConfigSchema>;

export const DEFAULT_HITL_CONFIG: ShoggothHitlConfig = {
  defaultApprovalTimeoutMs: 300_000,
  toolRisk: {
    read: "safe",
    write: "caution",
    exec: "critical",
    "memory.search": "safe",
    "memory.ingest": "caution",
  },
  roleBypassUpTo: {},
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
    hitl: DEFAULT_HITL_CONFIG,
    memory: DEFAULT_MEMORY_CONFIG,
    skills: DEFAULT_SKILLS_CONFIG,
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
  };
}
