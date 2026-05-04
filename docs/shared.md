# Shoggoth Shared Package Reference

The `@shoggoth/shared` package (`packages/shared`) contains cross-cutting utilities, types, constants, Zod schemas, and policy logic used by the [daemon](daemon.md), [CLI](cli.md), [platform bridges](platform-discord.md), and agent runtime. It is the single source of truth for configuration shape, session identity, filesystem layout, and access-control policy evaluation.

---

## Table of Contents

1. [Configuration Schema (`schema.ts`)](#configuration-schema)
2. [Layered Config Loader (`config.ts`)](#layered-config-loader)
3. [Deep Merge (`merge.ts`)](#deep-merge)
4. [Filesystem Layout (`paths.ts`)](#filesystem-layout)
5. [Session URNs (`session-urn.ts`)](#session-urns)
6. [Context Levels (`context-level.ts`)](#context-levels)
7. [System Context Envelopes (`system-context.ts`)](#system-context-envelopes)
8. [Effective Agent Resolution (`effective-agent-for-session.ts`)](#effective-agent-resolution)
9. [Agent-to-Agent Policy (`agent-to-agent-policy.ts`)](#agent-to-agent-policy)
10. [Spawn Subagents Policy (`spawn-subagents-policy.ts`)](#spawn-subagents-policy)
11. [Subagent Spawn Allow Policy (`subagent-spawn-allow-policy.ts`)](#subagent-spawn-allow-policy)
12. [Platform Config (`platform-config.ts`)](#platform-config)
13. [Logging (`logging.ts`)](#logging)
14. [Network Utilities (`network.ts`)](#network-utilities)
15. [Image Constants (`image.ts`)](#image-constants)
16. [JSON Redaction (`redact-json.ts`)](#json-redaction)
17. [Version (`version.ts`)](#version)

---

## Configuration Schema

**File:** `schema.ts`

Defines the entire Shoggoth configuration surface as Zod schemas. Every config key, type, and default lives here.

### Top-Level Config Types

| Type                     | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `ShoggothConfig`         | Fully resolved daemon config (all required fields populated). |
| `ShoggothConfigFragment` | Partial/layered JSON fragment — merged into the final config. |

### Key Sub-Schemas and Types

| Schema / Type                      | Purpose                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ShoggothModelsConfig`             | Model providers, failover chains, default invocation params, compaction settings. See [Models](models.md).                                                                                                                                                                                                      |
| `ShoggothModelsCompaction`         | Compaction tuning: `model`, `preserveRecentMessages`, `summaryMaxOutputTokens`, `contextWindowReserveTokens`, `compactionAbortTimeoutMs`.                                                                                                                                                                       |
| `ShoggothAgentModelsOverride`      | Per-agent model overrides (`primary` or `failoverChain`, `defaultInvocation`, `compaction`). Mutually exclusive: set only one of `primary` or `failoverChain`.                                                                                                                                                  |
| `ProviderModel`                    | Model entry within a provider: `name`, optional `contextWindowTokens`, optional `thinkingFormat` (`"native"` / `"xml-tags"` / `"none"`).                                                                                                                                                                        |
| `FailoverChainEntry`               | String ref like `"providerId/model"`.                                                                                                                                                                                                                                                                           |
| `ShoggothModelFailoverHop`         | Structured failover hop: `providerId`, `model`, optional `contextWindowTokens`, `thinkingFormat`, `capabilities`.                                                                                                                                                                                               |
| `ModelsRetry`                      | Global retry config: `maxRetries`, `retryDelayMs`, `retryBackoffMultiplier`, `markFailedDurationMs`.                                                                                                                                                                                                            |
| `ShoggothHitlConfig`               | Human-in-the-loop: `defaultApprovalTimeoutMs`, `toolRisk` map, `bypassUpTo` tier. See [Daemon — HITL](daemon.md#human-in-the-loop-hitl) and [Platform Discord — HITL](platform-discord.md#human-in-the-loop-hitl).                                                                                              |
| `HitlRiskTier`                     | `"safe"` \| `"caution"` \| `"critical"` \| `"never"`                                                                                                                                                                                                                                                            |
| `ShoggothPolicyConfig`             | Operator and agent tool/controlOp allow/deny/review lists, plus `auditRedaction.jsonPaths`. See [Daemon — Policy Engine](daemon.md#policy-engine).                                                                                                                                                              |
| `ShoggothPolicyFragment`           | Partial policy overlay for layered fragments.                                                                                                                                                                                                                                                                   |
| `ShoggothToolRules`                | `{ allow: string[], deny: string[], review: string[] }` — deny wins; empty allow + no `"*"` = default-deny.                                                                                                                                                                                                     |
| `ShoggothMemoryConfig`             | Workspace-relative memory paths (scanned for `*.md`) and embeddings sub-config. Absolute paths are rejected by schema.                                                                                                                                                                                          |
| `ShoggothMemoryEmbeddingsConfig`   | `enabled`, optional `modelId`, `openaiBaseUrl`, `apiKey`/`apiKeyEnv`.                                                                                                                                                                                                                                           |
| `ShoggothMcpConfig`                | MCP server definitions, pool scope (`"global"` / `"per_agent"` / `"per_session"`), idle timeout, server rules. See [MCP Integration](mcp-integration.md).                                                                                                                                                       |
| `ShoggothMcpServerEntry`           | Discriminated union on `transport`: `"stdio"`, `"tcp"`, or `"http"`. Each has an `id`, transport-specific fields, and optional `poolScope`.                                                                                                                                                                     |
| `ShoggothMcpServerPoolScope`       | `"inherit"` \| `"global"` \| `"per_agent"` \| `"per_session"`                                                                                                                                                                                                                                                   |
| `McpServerRules`                   | `{ allow: string[], deny: string[] }` — deny wins.                                                                                                                                                                                                                                                              |
| `ShoggothSkillsConfig`             | `scanRoots` (dirs scanned for `*.md` skill files) and `disabledIds`. See [Skills & Plugins](skills-plugins.md).                                                                                                                                                                                                 |
| `ShoggothRetentionConfig`          | Data lifecycle: `inboundMediaMaxAgeDays`, `inboundMediaMaxTotalBytes`, `transcriptMessageMaxAgeDays`, `transcriptMaxMessagesPerSession`, `kvMaxEntries`. See [Daemon — Retention](daemon.md#retention).                                                                                                         |
| `AttachmentHandlingMode`           | `"download"` \| `"inline"` \| `"hybrid"` — how inbound platform attachments are processed. Default: `"download"`.                                                                                                                                                                                               |
| `AttachmentHandlingConfig`         | `{ mode?: AttachmentHandlingMode }` — optional block under `platforms.attachmentHandling` (global) and `agents.list.<id>.platforms.attachmentHandling` (per-agent). Per-agent takes precedence over global; default `"download"`.                                                                               |
| `ShoggothRuntimeConfig`            | Daemon timers, feature flags, resilience settings. Includes `agentId`, `toolCallTimeoutMs`, `modelResilience`, `turnQueue`, `minimalContext`, etc.                                                                                                                                                              |
| `ShoggothAgentsConfig`             | Global agent defaults: `contextLevel`, `subagentContextLevel`, `internalStreaming`, `subagentModel`, `subagentMcp`. Contains `list` map of per-agent entries.                                                                                                                                                   |
| `ShoggothAgentEntry`               | Per-agent overrides: `displayName`, `emoji`, `models`, `platforms`, `memory`, `agentToAgent`, `subagentSpawnAllow`, `spawnSubagents`, `sessionQuery`, `policy`, `hitl`, `contextLevel`, `subagentContextLevel`, `toolDiscovery`, `thinkingDisplay`, `subagentModel`, `mcp`, `subagentMcp`, `toolCallTimeoutMs`. |
| `ShoggothAgentToAgentConfig`       | Global cross-agent `session_send` allow list.                                                                                                                                                                                                                                                                   |
| `ShoggothSessionQueryConfig`       | Global session transcript query allow list (`allowedAgentIds`).                                                                                                                                                                                                                                                 |
| `ShoggothSubagentSpawnAllowConfig` | `{ allow: string[] }` — which agent ids subagents may be spawned for.                                                                                                                                                                                                                                           |
| `ShoggothPluginEntry`              | Plugin: exactly one of `path` or `package`, optional `id`.                                                                                                                                                                                                                                                      |
| `ShoggothToolDiscoveryConfig`      | Tool discovery/collapse: `enabled`, `alwaysOn` tool IDs, `triggers` (match patterns → auto-enable tools). See [Daemon — Tool Discovery](daemon.md#tool-discovery).                                                                                                                                              |
| `ProcessDeclaration`               | Declarative sidecar process: `id`, `startPolicy` (`"boot"` / `"on-demand"`), `command`, `args`, `env`, `restartMode`, `maxRetries`, optional `health` check.                                                                                                                                                    |
| `ShoggothSearxngConfig`            | SearXNG web search: `baseUrl`, optional `apiKey`, `defaultCount`, `defaultLanguage`, `defaultTimeRange`, `engines`.                                                                                                                                                                                             |
| `ContextLevel`                     | `"none"` \| `"minimal"` \| `"light"` \| `"full"`                                                                                                                                                                                                                                                                |
| `ThinkingDisplay`                  | `"full"` \| `"indicator"` \| `"none"`                                                                                                                                                                                                                                                                           |

### Important Constants

| Constant                                | Value                                                   | Description                                                               |
| --------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `CONTEXT_LEVELS`                        | `["none", "minimal", "light", "full"]`                  | Valid context level values.                                               |
| `DEFAULT_HITL_CONFIG`                   | See source                                              | Default HITL risk tiers for builtins; `bypassUpTo: "safe"`.               |
| `DEFAULT_POLICY_CONFIG`                 | See source                                              | Operator gets `["*"]` for all; agent gets a curated controlOps allowlist. |
| `DEFAULT_MEMORY_CONFIG`                 | `{ paths: ["memory"], embeddings: { enabled: false } }` | Default workspace-relative `memory/` root, embeddings off.                |
| `DEFAULT_SKILLS_CONFIG`                 | `{ scanRoots: [], disabledIds: [] }`                    | No skill scan roots.                                                      |
| `DEFAULT_TOOL_CALL_TIMEOUT_MS`          | `600_000` (10 min)                                      | Default tool call timeout.                                                |
| `SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS` | `1_800_000` (30 min)                                    | Default idle eviction for MCP pool instances (all scopes).                |

### `defaultConfig(configDirectory)`

Returns a fully populated `ShoggothConfig` with sensible defaults (info log level, standard paths, Discord enabled, empty MCP/plugins/skills, default HITL and policy).

---

## Layered Config Loader

**File:** `config.ts`

### `loadLayeredConfig(configDir: string): ShoggothConfig`

1. Starts from `defaultConfig(configDir)`.
2. Recursively finds all `*.json` files under `configDir`, sorted by full path (ascending).
3. Each file is parsed, validated against `shoggothConfigFragmentSchema`, and deep-merged in order.
4. Files under `<configDir>/dynamic/` are lenient — read/parse/schema errors are warned and skipped (these are runtime agent-written overrides).
5. All other JSON files throw on error (operator-managed, must be valid).
6. Final merged object is validated against `shoggothConfigSchema`.

---

## Deep Merge

**File:** `merge.ts`

### `deepMerge(base, overlay): ShoggothConfigFragment`

Recursively merges two JSON-like objects. Later keys win. Arrays are replaced (not concatenated). `undefined` values in the overlay are skipped.

---

## Filesystem Layout

**File:** `paths.ts`

### `LAYOUT` (const object)

Canonical filesystem paths for the daemon:

| Key                | Path                                  | Description                                        |
| ------------------ | ------------------------------------- | -------------------------------------------------- |
| `configDir`        | `/etc/shoggoth/config.d`              | Layered config directory.                          |
| `stateDir`         | `/var/lib/shoggoth/state`             | Daemon state directory.                            |
| `stateDbFile`      | `/var/lib/shoggoth/state/shoggoth.db` | SQLite state database.                             |
| `workspacesRoot`   | `/var/lib/shoggoth/workspaces`        | Agent workspace root.                              |
| `operatorDir`      | `/var/lib/shoggoth/operator`          | Operator-only material (0700, not agent-readable). |
| `secretsDir`       | `/run/secrets`                        | Docker/Compose secrets.                            |
| `inboundMediaRoot` | `/var/lib/shoggoth/media/inbound`     | Inbound media files.                               |
| `runDir`           | `/run/shoggoth`                       | Runtime directory.                                 |
| `controlSocket`    | `/run/shoggoth/control.sock`          | Unix control socket.                               |

### `OPERATOR_GLOBAL_INSTRUCTIONS_BASENAME`

Value: `"GLOBAL.md"` — basename for gateway-injected system prompt text under the operator directory. Not readable by agents.

---

## Session URNs

**File:** `session-urn.ts`

Session identifiers are structured URNs:

```
agent:<agentId>:<platform>:<resourceType>:<leaf>[:<childLeaf>:…]
```

- `agentId`: alphanumeric plus `._-`, no colons.
- `platform`: short bridge name (e.g. `discord`).
- `resourceType`: e.g. `channel`, `dm`.
- `leaf` / `childLeaf`: opaque segments matching `/^[A-Za-z0-9._-]{1,128}$/`.
- Subagent URNs have 2+ tail segments after `resourceType`.

### Functions

| Function                                                              | Description                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `assertValidAgentId(agentId)`                                         | Throws if agent id is empty, `.`, `..`, or contains invalid chars.                                     |
| `resolveAgentWorkspacePath(root, agentId)`                            | Returns `{root}/{agentId}` (resolved absolute).                                                        |
| `parseAgentSessionUrn(id)`                                            | Returns `ParsedAgentSessionUrn` or `null`. Fields: `agentId`, `platform`, `resourceType`, `uuidChain`. |
| `isValidAgentSessionUrn(id)`                                          | Boolean check.                                                                                         |
| `isSubagentSessionUrn(id)`                                            | True when URN has >1 tail segment (child of a top-level session).                                      |
| `resolveTopLevelSessionUrn(id)`                                       | For subagent URNs, returns the parent top-level URN. `null` if already top-level or invalid.           |
| `formatAgentSessionUrn(agentId, platform, resourceType, sessionLeaf)` | Constructs a URN string with validation.                                                               |
| `mintAgentSessionUrn(agentId, platform, resourceType)`                | Formats a URN with a fresh random UUID leaf.                                                           |
| `mintSubagentSessionUrnFromParent(parentSessionId, subUuid?)`         | Creates a child URN under the parent's last leaf segment.                                              |
| `defaultPrimarySessionUrnForAgent(agentId, platform, resourceType)`   | Uses the reserved UUID `00000000-0000-4000-8000-000000000001`.                                         |

### Constants

| Constant                                | Description                              |
| --------------------------------------- | ---------------------------------------- |
| `SHOGGOTH_SESSION_UUID_RE`              | RFC 4122 UUID regex (case-insensitive).  |
| `SHOGGOTH_SESSION_URN_TAIL_SEGMENT_RE`  | `/^[A-Za-z0-9._-]{1,128}$/`              |
| `SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID` | `"00000000-0000-4000-8000-000000000001"` |

---

## Context Levels

**File:** `context-level.ts`

Controls how much context (tools, transcript, system prompt) a session receives.

### `resolveContextLevel(config, agentId, spawnOverride?, isSubagent?): ContextLevel`

Precedence (highest first):

1. Explicit `spawnOverride` parameter.
2. Per-agent config: `agents.list[agentId].subagentContextLevel` (subagents) or `.contextLevel` (top-level).
3. Global: `agents.subagentContextLevel` or `agents.contextLevel`.
4. Default: `"full"` for top-level, `"light"` for subagents.

### `validateContextLevel(value): ContextLevel`

Throws if value is not one of `"none"`, `"minimal"`, `"light"`, `"full"`.

---

## System Context Envelopes

**File:** `system-context.ts`

Provides a structured, anti-spoofed metadata channel for system-to-agent communication within session turns.

### `SystemContext` interface

```typescript
{
  kind: string;      // e.g. "workflow.complete", "subagent.task"
  summary: string;   // Human-readable summary
  data?: Record<string, unknown>;
  guidance?: string;  // Task-specific instructions
}
```

### Functions

| Function                                         | Description                                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `generateSystemContextToken()`                   | Returns an 8-char hex anti-spoofing token (random per session).                                                                  |
| `renderSystemContextEnvelope(ctx, token)`        | Renders a `SystemContext` into `--- BEGIN TRUSTED SYSTEM CONTEXT [token:…] ---` / `--- END …` block.                             |
| `wrapWithSystemContext(userContent, ctx, token)` | Prepends the envelope to user content.                                                                                           |
| `stripFalsifiedSystemContext(text)`              | Detects and discards inbound messages containing forged system context blocks. Replaces the entire message with a safety notice. |

---

## Effective Agent Resolution

**File:** `effective-agent-for-session.ts`

Resolves per-session effective configuration by merging global config with per-agent overrides from `agents.list.<agentId>`.

### Functions

| Function                                                          | Description                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `resolveAgentIdFromSessionId(sessionId)`                          | Extracts the logical agent id from a session URN.                                                               |
| `resolveEffectiveModelsConfig(cfg, sessionId)`                    | Merges global `models` with per-agent `models` overrides (failover chain, invocation, compaction).              |
| `resolveEffectiveMemoryForSession(cfg, sessionId)`                | Global `memory.paths` + per-agent `memory.paths` (deduped).                                                     |
| `resolveEffectiveSessionQueryAllowedAgentIds(cfg, callerAgentId)` | Set of agent ids the caller may query transcripts for (own id always included).                                 |
| `resolveEffectiveThinkingDisplay(cfg, sessionId)`                 | Per-agent `thinkingDisplay` or default `"none"`.                                                                |
| `formatAgentIdentityPrefix(cfg, sessionId)`                       | Returns `**<emoji> <displayName>:**\n` for platform messages. Emoji defaults to 🦑.                             |
| `evaluateMcpServerRules(serverId, rules)`                         | Evaluates allow/deny for a single MCP server id. Deny wins → allow check → default-deny.                        |
| `resolveEffectiveMcpServerRules(config, agentId, isSubagent)`     | 4-level merge cascade: global MCP rules → global subagent rules → per-agent rules. Per-field replace semantics. |

### Constants

| Constant                       | Value  |
| ------------------------------ | ------ |
| `SHOGGOTH_AGENT_DEFAULT_EMOJI` | `"🦑"` |

---

## Agent-to-Agent Policy

**File:** `agent-to-agent-policy.ts`

Controls cross-agent `session_send` targeting.

### `mergeAgentToAgentAllowPatterns(cfg, senderAgentId): string[]`

Merges global `agentToAgent.allow` with `agents.list.<senderId>.agentToAgent.allow` (deduped).

### `crossAgentSessionSendAllowed(cfg, senderAgentId, targetAgentId): boolean`

- Same-agent sends are always allowed.
- Otherwise checks merged allow patterns for the target id or `"*"`.
- Returns `false` when no allow data exists.

---

## Spawn Subagents Policy

**File:** `spawn-subagents-policy.ts`

### `effectiveSpawnSubagentsEnabled(cfg, logicalAgentId): boolean`

Whether an agent may use subagent builtins/control ops.

Precedence:

1. `agents.list.<id>.spawnSubagents` (per-agent boolean).
2. Top-level `spawnSubagents`.
3. Default: `true`.

---

## Subagent Spawn Allow Policy

**File:** `subagent-spawn-allow-policy.ts`

Controls which logical agent ids a sender may spawn subagents for.

### Functions

| Function                                                      | Description                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `mergeSubagentSpawnAllowPatterns(cfg, senderAgentId)`         | Merges global + per-sender `subagentSpawnAllow.allow` (deduped).                               |
| `hasExplicitSubagentSpawnAllowConfig(cfg, senderAgentId)`     | True if either global or per-sender config exists.                                             |
| `effectiveSubagentSpawnAllowedAgentIds(cfg, senderAgentId)`   | Effective allowlist. Falls back to `[senderAgentId]` when no config exists.                    |
| `agentMayInvokeSubagentSpawnByAllowlist(cfg, logicalAgentId)` | Whether the agent passes the allowlist check (separate from `effectiveSpawnSubagentsEnabled`). |

---

## Attachment Handling

**Schema:** `attachmentHandlingSchema` in `schema.ts`

Controls how inbound platform attachments (images, files) are processed before being passed to the model. Configurable globally under `platforms.attachmentHandling` and per-agent under `agents.list.<id>.platforms.attachmentHandling`. Per-agent config takes precedence over global. Default mode: `"download"`.

### Modes

| Mode       | Behavior                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `download` | Fetch attachment to `media/inbound/`, pass file path metadata to the agent. No image block injection. **Default.**                           |
| `inline`   | Fetch and base64-encode images into `ChatContentPart[]` image blocks. Non-images get text metadata only. No file written to disk.            |
| `hybrid`   | Download to `media/inbound/` AND inject image blocks for image attachments. Agent gets both the file path and the visual content in context. |

### Config Examples

```jsonc
// Default: download only (no inlining)
{
  "platforms": {
    "attachmentHandling": {
      "mode": "download"
    }
  }
}

// Restore previous behavior (base64 inline, no file on disk)
{
  "platforms": {
    "attachmentHandling": {
      "mode": "inline"
    }
  }
}

// Per-agent: vision-heavy agent gets hybrid, others get download
{
  "platforms": {
    "attachmentHandling": {
      "mode": "download"
    }
  },
  "agents": {
    "list": {
      "vision-agent": {
        "platforms": {
          "attachmentHandling": {
            "mode": "hybrid"
          }
        }
      }
    }
  }
}
```

### Resolution

`resolveAttachmentHandlingMode(config, sessionId)` in `packages/daemon/src/presentation/attachment-mode.ts`:

1. Extract agent id from the session URN.
2. Check `agents.list.<agentId>.platforms.attachmentHandling.mode` — if set, use it.
3. Fall back to `platforms.attachmentHandling.mode`.
4. Default: `"download"`.

---

## Platform Config

**File:** `platform-config.ts`

### Functions

| Function                                                 | Description                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `resolvePlatformConfig(cfg, platformId)`                 | Returns the platform's config object from `platforms` bag, or `undefined`. |
| `isPlatformEnabled(cfg, platformId)`                     | True if the platform entry exists and `enabled !== false`.                 |
| `resolveAgentPlatformConfig(agent, platformId)`          | Per-agent platform config from `agents.list.<id>.platforms.<platformId>`.  |
| `resolveAgentDefaultPlatform(cfg, agentId)`              | First key in the agent's `platforms` map, or `undefined`.                  |
| `registerPlatformConfigValidator(platformId, validator)` | Registers a validation function for platform-specific extension fields.    |
| `validatePlatformExtensions(platformId, raw)`            | Runs the registered validator (pass-through if none registered).           |

### `PlatformConfigValidator` type

```typescript
(raw: unknown) => { valid: boolean; errors?: string[] }
```

---

## Logging

**File:** `logging.ts`

Structured JSON-lines logger writing to stderr, suitable for container log aggregators.

### Types

| Type        | Description                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `LogLevel`  | `"debug"` \| `"info"` \| `"warn"` \| `"error"`                                                                                        |
| `LogFields` | `Record<string, unknown>`                                                                                                             |
| `Logger`    | Interface with `debug`, `info`, `warn`, `error` methods (each takes `msg` + optional `fields`) and `child(extra)` for scoped loggers. |

### Functions

| Function                                              | Description                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `createLogger({ component, minLevel?, baseFields? })` | Creates a new logger instance. Emits JSON lines: `{ ts, level, msg, component, ...fields }`.    |
| `initLogger({ minLevel? })`                           | Call once at daemon startup to set the global root logger.                                      |
| `getLogger(component)`                                | Returns a child logger scoped to a component. Safe at module level (lazy-inits root if needed). |
| `setRootLogger(logger)`                               | Replaces the root logger (for testing).                                                         |

Log level ordering: `debug(10) < info(20) < warn(30) < error(40)`.

---

## Network Utilities

**File:** `network.ts`

### `isPrivateIp(hostname: string): boolean`

Returns `true` when the IP address falls within a private/internal range that should be blocked for outbound fetch. Covers:

- IPv4: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `0.0.0.0/8`, `169.254.0.0/16`
- IPv6: `::1`, `::`, `fc00::/7` (ULA), `fe80::/10` (link-local)
- IPv4-mapped IPv6 (`::ffff:x.x.x.x`) delegates to IPv4 check.

Returns `false` for non-IP-literal strings (caller should DNS-resolve first).

---

## Image Constants

**File:** `image.ts`

| Constant                  | Description                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `IMAGE_MIME_TYPES`        | `Set` of supported MIME types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`. |
| `IMAGE_EXTENSION_TO_MIME` | Maps `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` → MIME type.                           |
| `IMAGE_MIME_TO_EXTENSION` | Reverse map: MIME type → file extension.                                             |
| `MAX_IMAGE_BLOCK_BYTES`   | `5 * 1024 * 1024` (5 MB) — max size for an image block in model context.             |

---

## JSON Redaction

**File:** `redact-json.ts`

Utilities for replacing sensitive values in JSON trees before logging/audit.

### Functions

| Function                                  | Description                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redactToolArgsJson(argsJson, jsonPaths)` | Parses JSON string, redacts at dot-separated paths, returns JSON string. Non-JSON input returns a truncated preview.                                                                                                |
| `redactJsonValue(value, jsonPaths)`       | Redacts an arbitrary JSON-serializable value at specified paths.                                                                                                                                                    |
| `redactDeep<T>(obj, jsonPaths)`           | Deep-clone + recursive walk. Single-segment paths (e.g. `"token"`) match any key at any depth. Multi-segment paths (e.g. `"env.API_KEY"`) match exact sub-paths at any depth. Matched values become `"[REDACTED]"`. |

---

## Version

**File:** `version.ts`

### `VERSION: string`

Reads the `version` field from the monorepo root `package.json` at import time. Single source of truth for daemon + CLI version strings.

---

## See Also

- [Daemon](daemon.md) — primary consumer of config, policy, sessions, and context levels
- [Models](models.md) — runtime behavior for `ShoggothModelsConfig`
- [Platform Discord](platform-discord.md) — platform config and HITL integration
- [MCP Integration](mcp-integration.md) — runtime behavior for `ShoggothMcpConfig`
- [Skills & Plugins](skills-plugins.md) — runtime behavior for `ShoggothSkillsConfig`
- [CLI](cli.md) — uses layered config loader and session URN utilities
- [Workflow](workflow.md) — uses session URNs and config for task orchestration
