import { z } from "zod";

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** MCP server allow/deny filtering. Deny wins; empty allow + no `*` → default-deny. */
export const mcpServerRulesSchema = z
  .object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  })
  .strict();

export type McpServerRules = z.infer<typeof mcpServerRulesSchema>;

export const mcpSourceIdSchema = z
  .string()
  .min(1)
  .refine((s) => !s.includes("."), {
    message: "MCP server id must not contain '.' (used as source id)",
  });

/** Per-server override for MCP connection pooling (omit or `inherit` → use top-level `mcp.poolScope`). */
export const shoggothMcpServerPoolScopeSchema = z.enum([
  "inherit",
  "global",
  "per_agent",
  "per_session",
]);

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

/** Default idle eviction for MCP pool instances when `perInstanceIdleTimeoutMs` is omitted. */
export const SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS = 30 * 60 * 1000;

export const shoggothMcpConfigSchema = z
  .object({
    servers: z.array(shoggothMcpServerEntrySchema),
    /**
     * Default for servers that omit `poolScope` or set `poolScope: "inherit"`.
     * `global`: one MCP connection set shared across all platform-bound sessions.
     * `per_session`: lazy pool per Shoggoth `sessionId` on first inbound turn; closed on orchestrator stop.
     */
    poolScope: z.enum(["global", "per_agent", "per_session"]).default("global"),
    /**
     * After an inbound platform turn completes, close that pool instance if no further\n     * turn completes within this many milliseconds. `0` disables. When omitted and any server uses an\n     * effective non-global pool, defaults to {@link SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS}.
     */
    perInstanceIdleTimeoutMs: z.number().int().nonnegative().optional(),
    serverRules: mcpServerRulesSchema.optional(),
  })
  .strict();

export type ShoggothMcpConfig = z.infer<typeof shoggothMcpConfigSchema>;