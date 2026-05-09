import type { OpenAIToolFunctionDefinition } from "@shoggoth/models";
import type {
  AggregateMcpCatalogResult,
  AggregatedTool,
  McpSourceCatalog,
  MessageToolPlatformSlice,
} from "@shoggoth/mcp-integration";
import { buildMessageToolDescriptor } from "@shoggoth/mcp-integration";
import {
  evaluateMcpServerRules,
  isSubagentSessionUrn,
  parseAgentSessionUrn,
  resolveContextLevel,
  resolveEffectiveMcpServerRules,
  type ContextLevel,
  type ContextLevelToolOverride,
  type ShoggothConfig,
} from "@shoggoth/shared";
import { messageToolContextRef } from "../messaging/message-tool-context-ref";
import { vaultServiceRef } from "../vault/vault-ref";
import {
  buildAggregatedMcpCatalog,
  mcpToolsForToolLoop,
  type ExternalMcpInvoke,
} from "../mcp/tool-loop-mcp";

export type SessionMcpToolContext = {
  readonly aggregated: AggregateMcpCatalogResult;
  readonly toolsOpenAi: OpenAIToolFunctionDefinition[];
  readonly toolsLoop: ReturnType<typeof mcpToolsForToolLoop>;
  readonly external?: ExternalMcpInvoke;
  /**
   * When tool discovery is active, holds the complete unfiltered catalog (all tools)
   * so the executor can route to any tool once enabled mid-loop.
   * Undefined when discovery is not active.
   */
  readonly fullAggregated?: AggregateMcpCatalogResult;
};

export function openAiToolsFromCatalog(
  aggregated: AggregateMcpCatalogResult,
): OpenAIToolFunctionDefinition[] {
  return aggregated.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.namespacedName,
      description: t.description ?? `${t.sourceId}-${t.originalName}`,
      parameters: (t.inputSchema ?? {
        type: "object",
        properties: {},
      }) as Record<string, unknown>,
    },
  }));
}

/**
 * Appends `builtin-message` when a messaging runtime registers a capability slice.
 */
function augmentSessionMcpToolContextWithMessageTool(
  base: SessionMcpToolContext,
  slice: MessageToolPlatformSlice | undefined,
): SessionMcpToolContext {
  const desc = buildMessageToolDescriptor(slice);
  if (!desc) return base;
  const extra: AggregatedTool = {
    ...desc,
    namespacedName: "builtin-message",
    sourceId: "builtin",
    originalName: "message",
  };
  const aggregated: AggregateMcpCatalogResult = {
    tools: [...base.aggregated.tools, extra],
  };
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: base.external,
  };
}

/** External MCP slices only (built-ins come from {@link buildAggregatedMcpCatalog}). */
export function buildSessionMcpToolContext(
  externalSources: readonly McpSourceCatalog[],
  external: ExternalMcpInvoke | undefined,
): SessionMcpToolContext {
  const aggregated = buildAggregatedMcpCatalog(externalSources);
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external,
  };
}

/**
 * Merges global + per-session MCP tool catalogs (global sources first). Duplicate `source-tool`
 * names across pools make aggregate throw — use distinct server `id`s.
 */
export function buildMixedSessionMcpToolContext(
  globalSources: readonly McpSourceCatalog[],
  globalExternal: ExternalMcpInvoke | undefined,
  sessionSources: readonly McpSourceCatalog[],
  sessionExternal: ExternalMcpInvoke | undefined,
  globalSourceIds: ReadonlySet<string>,
  perSessionSourceIds: ReadonlySet<string>,
): SessionMcpToolContext {
  const aggregated = buildAggregatedMcpCatalog([...globalSources, ...sessionSources]);
  let external: ExternalMcpInvoke | undefined;
  if (globalExternal && sessionExternal) {
    external = async (input) => {
      if (globalSourceIds.has(input.sourceId)) return globalExternal(input);
      if (perSessionSourceIds.has(input.sourceId)) return sessionExternal(input);
      return {
        resultJson: JSON.stringify({
          error: "mcp_source_unknown",
          sourceId: input.sourceId,
          detail: "Tool source id is not mapped to a connected MCP pool",
        }),
      };
    };
  } else {
    external = globalExternal ?? sessionExternal;
  }
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external,
  };
}

/**
 * Merges global + per-agent + per-session MCP tool catalogs (global first, then agent, then session).
 * Routes external invoke calls to the correct pool based on source ID membership.
 */
export function buildThreeTierSessionMcpToolContext(
  globalSources: readonly McpSourceCatalog[],
  globalExternal: ExternalMcpInvoke | undefined,
  agentSources: readonly McpSourceCatalog[],
  agentExternal: ExternalMcpInvoke | undefined,
  sessionSources: readonly McpSourceCatalog[],
  sessionExternal: ExternalMcpInvoke | undefined,
  globalSourceIds: ReadonlySet<string>,
  perAgentSourceIds: ReadonlySet<string>,
  perSessionSourceIds: ReadonlySet<string>,
): SessionMcpToolContext {
  const aggregated = buildAggregatedMcpCatalog([
    ...globalSources,
    ...agentSources,
    ...sessionSources,
  ]);
  const externals = [globalExternal, agentExternal, sessionExternal].filter(
    Boolean,
  ) as ExternalMcpInvoke[];
  let external: ExternalMcpInvoke | undefined;
  if (externals.length > 1) {
    external = async (input) => {
      if (globalSourceIds.has(input.sourceId) && globalExternal) return globalExternal(input);
      if (perAgentSourceIds.has(input.sourceId) && agentExternal) return agentExternal(input);
      if (perSessionSourceIds.has(input.sourceId) && sessionExternal) return sessionExternal(input);
      return {
        resultJson: JSON.stringify({
          error: "mcp_source_unknown",
          sourceId: input.sourceId,
          detail: "Tool source id is not mapped to a connected MCP pool",
        }),
      };
    };
  } else {
    external = externals[0];
  }
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external,
  };
}

export function buildBuiltinOnlySessionMcpToolContext(): SessionMcpToolContext {
  const aggregated = buildAggregatedMcpCatalog();
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: undefined,
  };
}

/**
 * `builtin-subagent` is only for top-level sessions; subagent runs must not recurse via tool list.
 */
export function omitBuiltinSubagentToolForSubagentSession(
  ctx: SessionMcpToolContext,
  sessionId: string,
): SessionMcpToolContext {
  if (!isSubagentSessionUrn(sessionId)) return ctx;
  const tools = ctx.aggregated.tools.filter(
    (t) => !(t.sourceId === "builtin" && t.originalName === "subagent"),
  );
  if (tools.length === ctx.aggregated.tools.length) return ctx;
  const aggregated: AggregateMcpCatalogResult = { tools };
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: ctx.external,
  };
}

/**
 * Standalone finalizer: appends `builtin-message` when a messaging runtime is active.
 */
export function messageToolFinalizer(
  ctx: SessionMcpToolContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _sessionId: string,
): SessionMcpToolContext {
  return augmentSessionMcpToolContextWithMessageTool(ctx, messageToolContextRef.current?.slice);
}

/**
 * Standalone finalizer: strips `builtin-subagent` for subagent session URNs.
 */
export function subagentToolStripFinalizer(
  ctx: SessionMcpToolContext,
  sessionId: string,
): SessionMcpToolContext {
  return omitBuiltinSubagentToolForSubagentSession(ctx, sessionId);
}

// ---------------------------------------------------------------------------
// Context-level tool filtering
// ---------------------------------------------------------------------------

/**
 * Default tool exclusions per context level. Uses namespaced names (e.g. `builtin-subagent`).
 * `none` is handled specially (excludes everything).
 */
const DEFAULT_EXCLUSIONS_BY_LEVEL: Record<ContextLevel, ReadonlySet<string>> = {
  none: new Set(), // handled specially — all tools excluded
  minimal: new Set([
    "builtin-workflow",
    "builtin-subagent",
    "builtin-session-list",
    "builtin-session-history",
    "builtin-session-spawn",
    "builtin-web-search",
  ]),
  light: new Set(),
  full: new Set(),
};

/**
 * Filter tools based on the resolved context level and optional config overrides.
 *
 * Flow:
 * 1. `none` → exclude everything (config `allow` can re-add specific tools)
 * 2. Start with default exclusions for the level
 * 3. Add `contextLevelTools[level].exclude` from config
 * 4. Remove `contextLevelTools[level].allow` from config
 * 5. Filter the tool list
 */
export function filterToolsByContextLevel(
  tools: readonly AggregatedTool[],
  level: ContextLevel,
  config?: ShoggothConfig,
): readonly AggregatedTool[] {
  const override: ContextLevelToolOverride | undefined = config?.contextLevelTools?.[level];

  if (level === "none") {
    // Exclude everything by default; config `allow` can re-add specific tools
    const allowed = new Set(override?.allow ?? []);
    if (allowed.size === 0) return [];
    return tools.filter((t) => allowed.has(t.namespacedName));
  }

  const excluded = new Set(DEFAULT_EXCLUSIONS_BY_LEVEL[level]);

  // Apply config exclusions (additive)
  if (override?.exclude) {
    for (const name of override.exclude) excluded.add(name);
  }

  // Apply config allows (subtractive from exclusions)
  if (override?.allow) {
    for (const name of override.allow) excluded.delete(name);
  }

  if (excluded.size === 0) return tools;
  return tools.filter((t) => !excluded.has(t.namespacedName));
}

/**
 * Apply context-level tool filtering to a {@link SessionMcpToolContext}.
 * Returns the context unchanged when no tools are removed.
 */
function applyContextLevelToolFilter(
  ctx: SessionMcpToolContext,
  level: ContextLevel,
  config?: ShoggothConfig,
): SessionMcpToolContext {
  const filtered = filterToolsByContextLevel(ctx.aggregated.tools, level, config);
  if (filtered.length === ctx.aggregated.tools.length) return ctx;
  const aggregated: AggregateMcpCatalogResult = { tools: filtered };
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: ctx.external,
  };
}

/**
 * Creates a context finalizer that filters tools based on the resolved context level.
 * The returned finalizer resolves the context level from the session URN and config.
 */
export function createContextLevelToolFinalizer(
  config: ShoggothConfig,
): (ctx: SessionMcpToolContext, sessionId: string) => SessionMcpToolContext {
  return (ctx, sessionId) => {
    const parsed = parseAgentSessionUrn(sessionId);
    const agentId = parsed?.agentId ?? "";
    const isSubagent = isSubagentSessionUrn(sessionId);
    const level = resolveContextLevel(config, agentId, undefined, isSubagent);
    return applyContextLevelToolFilter(ctx, level, config);
  };
}

// ---------------------------------------------------------------------------
// MCP server allow/deny rules — runtime filtering finalizer
// ---------------------------------------------------------------------------

/**
 * Creates a context finalizer that filters tools and wraps the external invoke
 * based on the resolved MCP server rules for the session. Evaluated per-call
 * (not cached) so dynamic config changes take effect on the next turn.
 */
export function createMcpServerRulesFinalizer(
  config: ShoggothConfig,
): (ctx: SessionMcpToolContext, sessionId: string) => SessionMcpToolContext {
  return (ctx, sessionId) => {
    const parsed = parseAgentSessionUrn(sessionId);
    const agentId = parsed?.agentId ?? "";
    const isSubagent = isSubagentSessionUrn(sessionId);
    const rules = resolveEffectiveMcpServerRules(config, agentId, isSubagent);

    // Determine which external sourceIds are denied
    const externalSourceIds = new Set(
      ctx.aggregated.tools.filter((t) => t.sourceId !== "builtin").map((t) => t.sourceId),
    );

    // Check if any source is actually denied — skip work if all are allowed
    const deniedSources = new Set<string>();
    for (const sid of externalSourceIds) {
      if (!evaluateMcpServerRules(sid, rules)) {
        deniedSources.add(sid);
      }
    }

    if (deniedSources.size === 0) return ctx;

    // Filter tools
    const filteredTools = ctx.aggregated.tools.filter(
      (t) => t.sourceId === "builtin" || !deniedSources.has(t.sourceId),
    );
    const aggregated: AggregateMcpCatalogResult = { tools: filteredTools };

    // Wrap external invoke to reject denied sourceIds
    const origExternal = ctx.external;
    const wrappedExternal: ExternalMcpInvoke | undefined = origExternal
      ? async (input) => {
          if (deniedSources.has(input.sourceId)) {
            return {
              resultJson: JSON.stringify({
                error: "mcp_server_denied",
                sourceId: input.sourceId,
                detail: `MCP server "${input.sourceId}" is denied by server rules`,
              }),
            };
          }
          return origExternal(input);
        }
      : undefined;

    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: wrappedExternal,
    };
  };
}

// ---------------------------------------------------------------------------
// Web-search tool (SearXNG) — conditionally injected via finalizer
// ---------------------------------------------------------------------------

const MEDIA_GENERATE_TOOL_DESCRIPTOR: AggregatedTool = {
  namespacedName: "builtin-media-generate",
  sourceId: "builtin",
  originalName: "media-generate",
  name: "media-generate",
  description:
    "Generate images, audio, video, or music using Google AI models. Results are written to disk and optionally surfaced inline.",
  inputSchema: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description:
          "Model name (e.g. gemini-2.5-flash-image, gemini-3-pro-image-preview, gemini-3.1-flash-image-preview, veo-3.1-generate-preview, lyria-3-pro-preview, gemini-2.5-flash-preview-tts)",
      },
      prompt: { type: "string", description: "Generation prompt" },
      params: {
        type: "object",
        description:
          "Parameters discriminated by 'kind': image (aspectRatio, numberOfImages, input_image), video (aspectRatio, durationSeconds, input_image, last_frame), speech (voice), music (durationSeconds)",
        properties: {
          kind: {
            type: "string",
            enum: ["image", "video", "speech", "music"],
            description: "Media type to generate",
          },
          aspectRatio: {
            type: "string",
            description: "Aspect ratio (image/video, e.g. '16:9', '1:1')",
          },
          numberOfImages: {
            type: "number",
            description: "Number of images to generate (image only)",
          },
          input_image: {
            type: "string",
            description: "Base64-encoded input image for editing (image/video)",
          },
          last_frame: {
            type: "string",
            description: "Base64-encoded last frame (video only)",
          },
          durationSeconds: {
            type: "number",
            description: "Duration in seconds (video/music)",
          },
          voice: {
            type: "string",
            description: "Voice name for TTS (speech only)",
          },
        },
        required: ["kind"],
      },
      output_path: {
        type: "string",
        description: "Workspace-relative output path. Auto-generated if omitted.",
      },
      show: {
        type: "boolean",
        description: "When true, surface image results to the user via builtin-show. Default true.",
      },
    },
    required: ["model", "prompt", "params"],
  },
};

const WEB_SEARCH_TOOL_DESCRIPTOR: AggregatedTool = {
  namespacedName: "builtin-web-search",
  sourceId: "builtin",
  originalName: "web-search",
  name: "web-search",
  description:
    "Search the web using SearXNG. Returns structured results with title, URL, snippet, and source engine.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: {
        type: "number",
        description: "Number of results (1-20, default: 5)",
      },
      categories: {
        type: "string",
        description: "Comma-separated categories: general, news, science, it, images",
      },
      language: {
        type: "string",
        description: "ISO 639-1 language code (default: en)",
      },
      timeRange: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: "Filter results by time range",
      },
    },
    required: ["query"],
  },
};

/**
 * Creates a context finalizer that appends `builtin-web-search` when SearXNG is configured.
 */
export function createWebSearchToolFinalizer(
  config: ShoggothConfig,
): (ctx: SessionMcpToolContext, sessionId: string) => SessionMcpToolContext {
  const enabled = Boolean(config.searxng?.baseUrl);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (ctx, _sessionId) => {
    if (!vaultServiceRef.current) return ctx;
    if (!enabled) return ctx;
    // Avoid duplicate if already present
    if (ctx.aggregated.tools.some((t) => t.namespacedName === "builtin-web-search")) return ctx;
    const aggregated: AggregateMcpCatalogResult = {
      tools: [...ctx.aggregated.tools, WEB_SEARCH_TOOL_DESCRIPTOR],
    };
    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: ctx.external,
    };
  };
}

/**
 */
export function createMediaGenerateToolFinalizer(
  config: ShoggothConfig,
): (ctx: SessionMcpToolContext, sessionId: string) => SessionMcpToolContext {
  const hasMediaConfig =
    (config.models?.providers ?? []).length > 0 ||
    ((config as any).mediaGeneration?.providers ?? []).some(
      (p: { models?: unknown[] }) => (p.models?.length ?? 0) > 0,
    );
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (ctx, _sessionId) => {
    if (!hasMediaConfig) return ctx;
    if (ctx.aggregated.tools.some((t) => t.namespacedName === "builtin-media-generate")) return ctx;
    const aggregated: AggregateMcpCatalogResult = {
      tools: [...ctx.aggregated.tools, MEDIA_GENERATE_TOOL_DESCRIPTOR],
    };
    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: ctx.external,
    };
  };
}

// ---------------------------------------------------------------------------
// Vault tool — conditionally injected when vault service is initialized
// ---------------------------------------------------------------------------

const VAULT_TOOL_DESCRIPTOR: AggregatedTool = {
  namespacedName: "builtin-vault",
  sourceId: "builtin",
  originalName: "vault",
  name: "vault",
  description:
    "Secure credential storage. Store, retrieve, delete, list, or inject secrets. Secrets are encrypted at rest and scoped per-agent.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "set", "delete", "list", "inject"],
        description: "Operation to perform.",
      },
      name: {
        type: "string",
        description: "Credential name. Required for get, set, delete, inject.",
      },
      value: {
        type: "string",
        description: "Credential value. Required for set.",
      },
      timeoutMs: {
        type: "number",
        description: "inject: FIFO read timeout in ms (default 30000).",
      },
    },
    required: ["action"],
  },
};

/**
 * Creates a context finalizer that appends `builtin-vault` when the vault service is initialized.
 */
export function createVaultToolFinalizer(): (
  ctx: SessionMcpToolContext,
  sessionId: string,
) => SessionMcpToolContext {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (ctx, _sessionId) => {
    if (!vaultServiceRef.current) return ctx;
    if (ctx.aggregated.tools.some((t) => t.namespacedName === "builtin-vault")) return ctx;
    const aggregated: AggregateMcpCatalogResult = {
      tools: [...ctx.aggregated.tools, VAULT_TOOL_DESCRIPTOR],
    };
    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: ctx.external,
    };
  };
}
