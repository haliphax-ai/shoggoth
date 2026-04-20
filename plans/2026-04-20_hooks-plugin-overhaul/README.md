---
date: 2026-04-20
completed: never
---

# Plugin System Overhaul — `hooks-plugin` Migration

## Summary

Replace the hand-rolled `HookRegistry` in `@shoggoth/plugins` with the typed hook primitives from the `hooks-plugin` npm package, define a rich set of daemon lifecycle hooks, and convert the Discord platform into a self-contained plugin that registers itself entirely through those hooks. Introduce a `MessagingPlatformPlugin` interface that codifies the hook contract any messaging platform must satisfy.

## Motivation

The current plugin system supports exactly two hooks (`daemon.startup`, `daemon.shutdown`) with untyped `ctx?: unknown` payloads. This is insufficient for the project's stated goal of pluggable platforms (see `AGENTS.md`: "Platforms should plug into system internals using hook points so that the implementation remains packaged and separate").

Today, Discord is wired directly into `daemon/src/index.ts` via ~200 lines of imperative glue: gateway startup, slash command registration, HITL reaction wiring, reaction passthrough, subagent extension wiring, message tool context, platform registration, health probe registration, and shutdown drain registration. Adding a second platform (Telegram, Slack) would require duplicating this glue or creating ad-hoc abstractions.

The `hooks-plugin` package provides typed `SyncHook`, `AsyncHook`, `SyncWaterfallHook`, `AsyncParallelHook`, and `AsyncWaterfallHook` primitives with a `PluginSystem` orchestrator. Adopting it gives us:

- Strongly typed hook arguments and return values per hook point
- Waterfall hooks for transformable pipelines (e.g. system prompt assembly)
- Parallel async hooks for independent startup tasks
- A `PluginSystem` class with plugin registration, lifecycle, locking, and error listeners
- Built-in performance monitoring and debugging

## Design

### Hook Taxonomy

Hooks are grouped by lifecycle phase. Each hook has a defined type (sync/async/waterfall/parallel), typed arguments, and a clear firing point in the daemon boot/run/shutdown sequence.

#### Daemon Lifecycle Hooks

| Hook Name | Type | Args | Fires When |
|---|---|---|---|
| `daemon.configure` | `SyncWaterfallHook` | `DaemonConfigureCtx` | After config is loaded, before any subsystem starts. Plugins can inspect/augment config. |
| `daemon.startup` | `AsyncHook` | `DaemonStartupCtx` | After DB, control plane, and core subsystems are initialized. Plugins perform async setup. |
| `daemon.ready` | `AsyncHook` | `DaemonReadyCtx` | After all plugins have started and platforms are connected. Final "system is live" signal. |
| `daemon.shutdown` | `AsyncHook` | `DaemonShutdownCtx` | Graceful shutdown initiated. Plugins release resources. |

#### Platform Lifecycle Hooks

| Hook Name | Type | Args | Fires When |
|---|---|---|---|
| `platform.register` | `SyncHook` | `PlatformRegisterCtx` | During startup. Platforms register their URN policy, capabilities, and health probes. |
| `platform.start` | `AsyncHook` | `PlatformStartCtx` | After `platform.register`. Platforms connect to external services (gateway, API). |
| `platform.stop` | `AsyncHook` | `PlatformStopCtx` | During shutdown. Platforms disconnect gracefully. |

#### Messaging Hooks

| Hook Name | Type | Args | Fires When |
|---|---|---|---|
| `message.inbound` | `AsyncHook` | `MessageInboundCtx` | A normalized inbound message is ready for dispatch. Platform adapters produce these. |
| `message.outbound` | `AsyncWaterfallHook` | `MessageOutboundCtx` | An outbound message is about to be delivered. Plugins can transform content. |
| `message.reaction` | `AsyncHook` | `MessageReactionCtx` | A reaction event is received from a platform. |

#### Session Hooks

| Hook Name | Type | Args | Fires When |
|---|---|---|---|
| `session.turn.before` | `AsyncHook` | `SessionTurnBeforeCtx` | Before a model turn executes. |
| `session.turn.after` | `AsyncHook` | `SessionTurnAfterCtx` | After a model turn completes (success or failure). |
| `session.segment.change` | `SyncHook` | `SessionSegmentChangeCtx` | A session's context segment changes (new/reset). |

#### Health Hooks

| Hook Name | Type | Args | Fires When |
|---|---|---|---|
| `health.register` | `SyncHook` | `HealthRegisterCtx` | During startup. Plugins register health probes. |

### `MessagingPlatformPlugin` Interface

A TypeScript interface that defines the complete set of hooks a messaging platform plugin must implement. This serves as both documentation and compile-time validation for platform authors.

```ts
interface MessagingPlatformPlugin {
  readonly name: string;
  readonly platformId: string;
  hooks: {
    'platform.register': (ctx: PlatformRegisterCtx) => void;
    'platform.start': (ctx: PlatformStartCtx) => Promise<void>;
    'platform.stop': (ctx: PlatformStopCtx) => Promise<void>;
    'health.register': (ctx: HealthRegisterCtx) => void;
  };
}
```

A `defineMessagingPlatformPlugin` helper validates that all required hooks are present and returns a properly typed `Plugin` object for the `PluginSystem`.

### Discord as a Plugin

The Discord platform becomes a plugin that satisfies `MessagingPlatformPlugin`:

- `platform.register` — registers `discordPlatformRegistration` URN policy, declares capabilities
- `platform.start` — runs `startDaemonDiscordMessaging` + `startDiscordPlatform`, wires HITL reactions, slash commands, reaction passthrough, subagent extension, message tool context
- `platform.stop` — disconnects gateway, unsubscribes bus, shuts down MCP runtime
- `health.register` — registers `createDiscordProbe`
- `daemon.shutdown` — runs `stopAllPlatforms`, clears subagent extension ref

All of the ~200 lines of Discord glue in `daemon/src/index.ts` move into `platform-discord/src/plugin.ts`.

### Plugin Manifest

The `shoggoth.json` manifest is updated to support the full hook name set and optional metadata:

```json
{
  "name": "platform-discord",
  "version": "0.1.0",
  "kind": "messaging-platform",
  "entrypoint": "./src/plugin.ts",
  "hooks": {
    "platform.register": "./src/plugin.ts#register",
    "platform.start": "./src/plugin.ts#start",
    "platform.stop": "./src/plugin.ts#stop",
    "health.register": "./src/plugin.ts#healthRegister",
    "daemon.shutdown": "./src/plugin.ts#shutdown"
  }
}
```

### Daemon Boot Sequence (revised)

1. Load config
2. Create `PluginSystem` with all lifecycle hooks
3. Fire `daemon.configure` (waterfall — plugins can augment config)
4. Open state DB, run migrations
5. Start control plane, config hot-reload
6. Load plugins from config → each calls `pluginSystem.use()`
7. Fire `platform.register` (sync — platforms register URN policies, capabilities)
8. Fire `health.register` (sync — platforms register health probes)
9. Fire `platform.start` (async — platforms connect to external services)
10. Fire `daemon.startup` (async — general plugin startup)
11. Fire `daemon.ready` (async — system is live)
12. On shutdown signal:
    - Fire `platform.stop` (async)
    - Fire `daemon.shutdown` (async)

## Implementation Phases

### Phase 1: Add `hooks-plugin` dependency, define hook types, and implement config freeze\n\nInstall `hooks-plugin` in `@shoggoth/plugins`. Define all hook context types and the `ShoggothPluginSystem` class that instantiates the typed hooks. Implement a configuration freeze mechanism: after the `daemon.configure` waterfall completes, the resulting config object is deep-frozen (`Object.freeze`, recursive) to prevent downstream plugins or hooks from mutating it. This mitigates the risk of a misbehaving plugin corrupting config via the waterfall.\n\n**Files:**\n- `packages/plugins/package.json` — add `hooks-plugin` dependency\n- `packages/plugins/src/hook-types.ts` — NEW: all hook context type definitions\n- `packages/plugins/src/plugin-system.ts` — NEW: `ShoggothPluginSystem` class wrapping `PluginSystem` from `hooks-plugin`; includes `freezeConfig` utility that deep-freezes the config object returned from the `daemon.configure` waterfall\n- `packages/plugins/src/messaging-platform-plugin.ts` — NEW: `MessagingPlatformPlugin` interface and `defineMessagingPlatformPlugin` helper\n- `packages/plugins/src/index.ts` — re-export new types\n- `packages/plugins/test/plugin-system.test.ts` — NEW: tests for hook registration, firing, and config freeze (verify mutation after freeze throws in strict mode)

### Phase 2: Replace `HookRegistry` with `hooks-plugin` internals

Delete the hand-rolled `HookRegistry` and replace all usages with `ShoggothPluginSystem`. Update `loadPluginFromDirectory` and `loadAllPluginsFromConfig` to use the new system. Update the manifest schema to support the full hook name set.

**Files:**
- `packages/plugins/src/hook-registry.ts` — DELETE (replaced by `ShoggothPluginSystem`)
- `packages/plugins/src/plugin-loader.ts` — update to use `ShoggothPluginSystem`
- `packages/plugins/src/shoggoth-manifest.ts` — update schema with full hook names, `kind`, `entrypoint`
- `packages/plugins/test/plugin-loader.test.ts` — update tests
- `packages/plugins/test/hook-registry.test.ts` — DELETE or rewrite against new system
- `packages/daemon/src/plugins/bootstrap.ts` — update to create and pass `ShoggothPluginSystem`

### Phase 3: Define daemon-side hook firing points

Wire the daemon's boot sequence to fire hooks at the appropriate points. The daemon creates the `ShoggothPluginSystem`, loads plugins, and fires hooks in order. Initially, no plugins consume the new hooks — this phase just establishes the firing points.

**Files:**
- `packages/daemon/src/index.ts` — restructure boot sequence around hook firing points
- `packages/daemon/src/plugins/bootstrap.ts` — expose `ShoggothPluginSystem` instance to daemon
- `packages/daemon/src/plugins/daemon-hooks.ts` — NEW: helper that fires hooks at the right points
- `packages/daemon/test/plugins/daemon-hooks.test.ts` — NEW: tests for hook firing order

### Phase 4: Extract Discord glue into a plugin

Move all Discord-specific wiring from `daemon/src/index.ts` into `platform-discord/src/plugin.ts`. The plugin implements `MessagingPlatformPlugin` and registers itself via hooks. The daemon's `index.ts` becomes platform-agnostic.

**Files:**
- `packages/platform-discord/src/plugin.ts` — NEW: Discord plugin implementing `MessagingPlatformPlugin`
- `packages/platform-discord/src/index.ts` — export plugin
- `packages/platform-discord/shoggoth.json` — NEW: manifest
- `packages/daemon/src/index.ts` — remove all Discord-specific imports and glue code
- `packages/daemon/src/plugins/bootstrap.ts` — register built-in platform plugins from config
- `packages/daemon/test/plugins/discord-plugin.test.ts` — NEW: integration test for Discord plugin lifecycle

### Phase 5: Documentation and cleanup

Update docs to reflect the new plugin system, hook catalog, and platform plugin authoring guide.

**Files:**
- `docs/plugins.md` — rewrite for new plugin system
- `docs/platform-discord.md` — update bootstrap/architecture sections
- `docs/daemon.md` — update boot sequence, plugin section
- `packages/plugins/README.md` — NEW: package-level docs

## Testing Strategy

- Unit tests for `ShoggothPluginSystem`: hook registration, firing order, typed args, waterfall chaining, error handling
- Unit tests for manifest parsing and validation
- Unit tests for `MessagingPlatformPlugin` validation (missing required hooks → error)
- Integration test for Discord plugin: mock gateway, verify hook firing sequence (register → start → ready → stop → shutdown)
- Existing test suite must pass unchanged (917+ tests) — the refactor is internal

## Considerations

- `PlatformStartCtx` groups shared daemon dependencies (hitlStack, policyEngine, hitlConfigRef, hitlAutoApproveGate) into a `deps: PlatformDeps` sub-object to keep the context readable.
- `hooks-plugin` has a single runtime dependency (`aidly`). Verify it's acceptable for the project.
- The `PluginSystem.lock()` mechanism can be used after startup to prevent late plugin registration — good for security.
- Waterfall hooks (`daemon.configure`, `message.outbound`) allow plugins to transform data in a pipeline. Order matters — plugins fire in registration order (FIFO).
- The `hooks-plugin` `listenError` API provides centralized error handling for hook execution failures, replacing the current try/catch-per-handler pattern.
- Future platforms (Telegram, Slack) implement `MessagingPlatformPlugin` and drop in as config entries.
- The `session.turn.before`/`session.turn.after` hooks enable observability plugins (logging, metrics, tracing) without modifying core code.
- `daemon.configure` as a waterfall hook is powerful but risky — a misbehaving plugin could corrupt config. The config object is deep-frozen after the waterfall completes (implemented in Phase 1).

## Plan Assets

- [`spec.md`](spec.md) — Full type signatures, interfaces, and data structures
- [`discord-hook-points.md`](discord-hook-points.md) — Every Discord integration point mapped to its target hook (Phase 4 checklist)
- [`architecture.svg`](architecture.svg) — Component diagram showing hook-driven architecture

## Migration

- No database schema changes.
- Config format gains an optional `kind` field on plugin entries (for validation only — not required).
- The daemon's boot sequence changes internally but produces identical external behavior.
- State files are unaffected.
