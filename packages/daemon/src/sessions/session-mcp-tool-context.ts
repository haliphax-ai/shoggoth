import type { OpenAIToolFunctionDefinition } from "@shoggoth/models";
import type Database from "better-sqlite3";
import type {
  AggregateMcpCatalogResult,
  AggregatedTool,
  McpSourceCatalog,
  MessageToolPlatformSlice,
} from "@shoggoth/mcp-integration";
import {
  buildAskToolDescriptor,
  buildMessageToolDescriptor,
  createAggregateMcpCatalogResult,
} from "@shoggoth/mcp-integration";
import {
  effectiveMaxSpawnDepth,
  evaluateMcpServerRules,
  isSubagentSessionUrn,
  maySpawnSubagentAtDepth,
  parseAgentSessionUrn,
  resolveAgentIdFromSessionId,
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
import type { SessionMcpContextFinalizer } from "./session-mcp-runtime";
import { computeSessionDepthFromStore, createSessionStore } from "./session-store";

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
 * Appends `builtin-message` and `builtin-ask` when a messaging runtime
 * registers a capability slice. `builtin-ask` is only added when the
 * platform supports reactions (the ask tool is a choice prompt).
 */
function augmentSessionMcpToolContextWithMessageTools(
  base: SessionMcpToolContext,
  slice: MessageToolPlatformSlice | undefined,
): SessionMcpToolContext {
  const extras: AggregatedTool[] = [];
  const desc = buildMessageToolDescriptor(slice);
  if (desc) {
    extras.push({
      ...desc,
      namespacedName: "builtin-message",
      sourceId: "builtin",
      originalName: "message",
    });
  }
  const askDesc = buildAskToolDescriptor(slice);
  if (askDesc) {
    extras.push({
      ...askDesc,
      namespacedName: "builtin-ask",
      sourceId: "builtin",
      originalName: "ask",
    });
  }
  if (extras.length === 0) return base;
  const aggregated = createAggregateMcpCatalogResult([...base.aggregated.tools, ...extras]);
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
 * Strips `builtin-subagent` from the tool catalog when the session is not
 * permitted to spawn subagents. Pure filter — the depth-aware factory
 * finalizer resolves the maxSpawnDepth decision; no DB access here.
 */
function stripSubagentToolWhenSpawnDenied(
  ctx: SessionMcpToolContext,
  maySpawn: boolean,
): SessionMcpToolContext {
  if (maySpawn) return ctx;
  const tools = ctx.aggregated.tools.filter(
    (t) => !(t.sourceId === "builtin" && t.originalName === "subagent"),
  );
  if (tools.length === ctx.aggregated.tools.length) return ctx;
  const aggregated = createAggregateMcpCatalogResult(tools);
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: ctx.external,
  };
}

/**
 * Standalone finalizer: appends `builtin-message` and `builtin-ask` when a
 * messaging runtime is active.
 */
export function messageToolFinalizer(
  ctx: SessionMcpToolContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _sessionId: string,
): SessionMcpToolContext {
  return augmentSessionMcpToolContextWithMessageTools(ctx, messageToolContextRef.current?.slice);
}

/**
 * Factory finalizer: mirrors the `maxSpawnDepth` nesting gate enforced by the
 * `subagent` tool handler and the `subagent_spawn` control op. For subagent
 * session URNs, `builtin-subagent` is stripped only when spawning would be
 * denied at the session's lineage depth — with `maxSpawnDepth >= 2` a depth-1
 * subagent keeps the tool so it can spawn its own children. Unresolvable
 * lineage (missing session row or cycle) strips the tool, matching the
 * handler's deny-by-default. Top-level sessions are never stripped; the
 * handler gate still applies at call time.
 */
export function createSubagentToolStripFinalizer(
  db: Database.Database,
  config: ShoggothConfig,
): SessionMcpContextFinalizer {
  return (ctx, sessionId) => {
    if (!isSubagentSessionUrn(sessionId)) return ctx;
    let maySpawn: boolean;
    try {
      const depth = computeSessionDepthFromStore(createSessionStore(db), sessionId);
      const agentId = resolveAgentIdFromSessionId(sessionId);
      maySpawn = maySpawnSubagentAtDepth(depth, effectiveMaxSpawnDepth(config, agentId));
    } catch {
      // DB unavailable (e.g. during test teardown) — mirror the deny default.
      maySpawn = false;
    }
    return stripSubagentToolWhenSpawnDenied(ctx, maySpawn);
  };
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
  const aggregated = createAggregateMcpCatalogResult(filtered);
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

    // Server ids flagged `explicit` are never matched by wildcard/`*` allow
    // patterns — they must be named exactly in the effective allow list.
    const explicitServerIds = new Set(
      config.mcp?.servers?.filter((s) => s.explicit).map((s) => s.id) ?? [],
    );

    // Determine which external sourceIds are denied
    const externalSourceIds = new Set(
      ctx.aggregated.tools.filter((t) => t.sourceId !== "builtin").map((t) => t.sourceId),
    );

    // Check if any source is actually denied — skip work if all are allowed
    const deniedSources = new Set<string>();
    for (const sid of externalSourceIds) {
      if (!evaluateMcpServerRules(sid, rules, explicitServerIds.has(sid))) {
        deniedSources.add(sid);
      }
    }

    if (deniedSources.size === 0) return ctx;

    // Filter tools
    const filteredTools = ctx.aggregated.tools.filter(
      (t) => t.sourceId === "builtin" || !deniedSources.has(t.sourceId),
    );
    const aggregated = createAggregateMcpCatalogResult(filteredTools);

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
    "Generate images, audio, video, or music using Google AI models. Results are always saved to disk at the required output_path.",
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
          "Parameters discriminated by 'kind': image (aspectRatio, size, numberOfImages, input_path), video (aspectRatio, durationSeconds, input_path, last_frame), speech (voice), music (durationSeconds)",
        properties: {
          kind: {
            type: "string",
            enum: ["image", "video", "speech", "music"],
            description: "Media type to generate",
          },
          aspectRatio: {
            type: "string",
            description:
              "Normalized aspect ratio string (e.g. '16:9', '1:1', '9:16', '4:3', '3:4'). Passed through to providers as-is. For OpenAI DALL-E (images endpoint), it maps to fixed pixel sizes. For OpenRouter and GPT-image chat completions, it maps to the provider's normalized ratio and a tiered resolution (default '2K'). Providers may clamp to their supported subset.",
          },
          size: {
            type: "string",
            description:
              "Image size. Can be a pixel string (e.g. '1024x1024') for DALL-E, a tier string ('512', '1K', '2K', '4K'), or auto-inferred from a pixel string. For chat-image adapters the pixel string is converted to a tiered resolution. Ignored when aspectRatio is set.",
          },
          numberOfImages: {
            type: "number",
            description: "Number of images to generate (image only)",
          },
          input_path: {
            type: "string",
            description: "Workspace-relative path to an input image file for editing (image/video)",
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
        description: "Workspace-relative output path for the generated file (required).",
      },
    },
    required: ["model", "prompt", "params", "output_path"],
  },
};

/**
 * Build the `builtin-decision` tool descriptor from config. When a
 * `defaultModel` is configured, the `model` input becomes optional and the
 * descriptions name the default model/provider combo so the agent knows
 * exactly which model will handle an omitted-model call.
 */
function decisionToolDescriptor(config: ShoggothConfig): AggregatedTool {
  const decision = (config as any).decision;
  const providers: { id?: string; models?: { name: string }[] }[] = decision?.providers ?? [];
  const defaultModel: string | undefined = decision?.defaultModel;
  // defaultModel is already in provider-id/model-name format; the provider
  // prefix names the combo explicitly, so no separate provider lookup is needed
  const defaultModelLabel = defaultModel != null ? `'${defaultModel}'` : undefined;
  const exampleRef =
    providers[0]?.id != null && providers[0]?.models?.[0]?.name != null
      ? `${providers[0].id}/${providers[0].models[0].name}`
      : `provider-id/model-name`;

  const description =
    `Query a decision (classifier) model. Evaluates a state against typed questions ` +
    `(noul: yes/no probability, choice: pick one option, score: rate against ordered levels) ` +
    `and returns structured answers with probabilities. Models are referenced as ` +
    `provider-id/model-name.` +
    (defaultModelLabel
      ? ` Uses the default configured model ${defaultModelLabel} when model is omitted.`
      : ` No default model is configured, so model is required.`);

  const modelDescription = defaultModelLabel
    ? `Optional. Model in provider-id/model-name format (e.g. ${exampleRef}). ` +
      `Defaults to the configured default model ${defaultModelLabel} when omitted.`
    : `Required. Model in provider-id/model-name format (e.g. ${exampleRef}). ` +
      `No default model is configured, so this must be given.`;

  return {
    namespacedName: "builtin-decision",
    sourceId: "builtin",
    originalName: "decision",
    name: "decision",
    description,
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: modelDescription,
        },
        state: {
          description:
            "The content to evaluate: a plain string, or structured data (object/array) such as chat logs or the current state of your application.",
        },
        questions: {
          type: "object",
          description:
            "Map of typed question id -> question. Each question has a type (noul | choice | score), instructions (string | object | array), and type-specific criteria: noul takes optional {true, false} descriptions, choice takes a map of option -> rubric (max 255 options), score takes an ordered array of 2-10 level descriptions.",
          additionalProperties: true,
        },
        timeout_ms: {
          type: "number",
          description: "Optional request timeout in milliseconds",
        },
      },
      required: defaultModel ? ["state", "questions"] : ["model", "state", "questions"],
    },
  };
}

/**
 * Build the `builtin-rerank` tool descriptor from config. When a
 * `defaultModel` is configured, the `model` input becomes optional and the
 * descriptions name the default model/provider combo so the agent knows
 * exactly which model will handle an omitted-model call.
 */
function rerankToolDescriptor(config: ShoggothConfig): AggregatedTool {
  const rerank = config.rerank;
  const providers: { id?: string; models?: { name: string }[] }[] = rerank?.providers ?? [];
  const defaultModel: string | undefined = rerank?.defaultModel;
  // defaultModel is already in provider-id/model-name format; the provider
  // prefix names the combo explicitly, so no separate provider lookup is needed
  const defaultModelLabel = defaultModel != null ? `'${defaultModel}'` : undefined;
  const exampleRef =
    providers[0]?.id != null && providers[0]?.models?.[0]?.name != null
      ? `${providers[0].id}/${providers[0].models[0].name}`
      : `provider-id/model-name`;

  const description =
    `Score and order candidate documents against a query with a rerank model ` +
    `(Cohere-style /v1/rerank API; also works with OpenRouter-compatible endpoints). ` +
    `Returns results as {index, relevance_score} pairs ordered by relevance — ` +
    "useful for RAG pipelines, search result ordering, and any task where " +
    `candidate documents need relevance scoring. Models are referenced as ` +
    `provider-id/model-name.` +
    (defaultModelLabel
      ? ` Uses the default configured model ${defaultModelLabel} when model is omitted.`
      : ` No default model is configured, so model is required.`);

  const modelDescription = defaultModelLabel
    ? `Optional. Model in provider-id/model-name format (e.g. ${exampleRef}). ` +
      `Defaults to the configured default model ${defaultModelLabel} when omitted.`
    : `Required. Model in provider-id/model-name format (e.g. ${exampleRef}). ` +
      `No default model is configured, so this must be given.`;

  return {
    namespacedName: "builtin-rerank",
    sourceId: "builtin",
    originalName: "rerank",
    name: "rerank",
    description,
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: modelDescription,
        },
        query: {
          type: "string",
          description: "The query text used to score the relevance of each document.",
        },
        documents: {
          type: "array",
          items: { type: "string" },
          description:
            "Candidate documents to score, as an array of strings. Results reference documents by position (index).",
        },
        top_n: {
          type: "number",
          description: "Optional. Return at most this many results (honored server-side).",
        },
        timeout_ms: {
          type: "number",
          description: "Optional request timeout in milliseconds",
        },
      },
      required: defaultModel ? ["query", "documents"] : ["model", "query", "documents"],
    },
  };
}

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
    const aggregated = createAggregateMcpCatalogResult([
      ...ctx.aggregated.tools,
      WEB_SEARCH_TOOL_DESCRIPTOR,
    ]);
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
    const aggregated = createAggregateMcpCatalogResult([
      ...ctx.aggregated.tools,
      MEDIA_GENERATE_TOOL_DESCRIPTOR,
    ]);
    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: ctx.external,
    };
  };
}

// ---------------------------------------------------------------------------
// Decision tool (TypeSafe System One classifiers) — conditionally injected
// via finalizer when a decision provider with models is configured
// ---------------------------------------------------------------------------

/**
 * Creates a context finalizer that appends `builtin-decision` when a decision
 * provider with at least one model is configured.
 */
export function createDecisionToolFinalizer(
  config: ShoggothConfig,
): (ctx: SessionMcpToolContext, sessionId: string) => SessionMcpToolContext {
  const hasDecisionConfig = ((config as any).decision?.providers ?? []).some(
    (p: { models?: unknown[] }) => (p.models?.length ?? 0) > 0,
  );
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (ctx, _sessionId) => {
    if (!hasDecisionConfig) return ctx;
    if (ctx.aggregated.tools.some((t) => t.namespacedName === "builtin-decision")) return ctx;
    const aggregated = createAggregateMcpCatalogResult([
      ...ctx.aggregated.tools,
      decisionToolDescriptor(config),
    ]);

    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: ctx.external,
    };
  };
}

// ---------------------------------------------------------------------------
// Rerank tool (Cohere-style rerank models) — conditionally injected
// via finalizer when a rerank provider with models is configured
// ---------------------------------------------------------------------------

/**
 * Creates a context finalizer that appends `builtin-rerank` when a rerank
 * provider with at least one model is configured.
 */
export function createRerankToolFinalizer(
  config: ShoggothConfig,
): (ctx: SessionMcpToolContext, sessionId: string) => SessionMcpToolContext {
  const hasRerankConfig = (config.rerank?.providers ?? []).some((p) => (p.models?.length ?? 0) > 0);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (ctx, _sessionId) => {
    if (!hasRerankConfig) return ctx;
    if (ctx.aggregated.tools.some((t) => t.namespacedName === "builtin-rerank")) return ctx;
    const aggregated = createAggregateMcpCatalogResult([
      ...ctx.aggregated.tools,
      rerankToolDescriptor(config),
    ]);
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
    const aggregated = createAggregateMcpCatalogResult([
      ...ctx.aggregated.tools,
      VAULT_TOOL_DESCRIPTOR,
    ]);
    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: ctx.external,
    };
  };
}
