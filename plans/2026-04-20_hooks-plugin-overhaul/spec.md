# Plugin System Overhaul — Specification

This document defines the type signatures, interfaces, and data structures for the `hooks-plugin` migration. It is the companion to the [plan README](README.md).

---

## 1. Hook Context Types

Every hook receives a single typed context object. Contexts carry only what the hook handler needs — no god objects.

```ts
import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { PlatformRegistration } from "@shoggoth/messaging";
import type { InternalMessage } from "@shoggoth/messaging";
import type { PlatformRuntime } from "@shoggoth/messaging";

// ---------------------------------------------------------------------------
// Daemon Lifecycle
// ---------------------------------------------------------------------------

/** Waterfall: plugins can return a modified config. */
interface DaemonConfigureCtx {
  readonly config: ShoggothConfig;
}

interface DaemonStartupCtx {
  readonly db: Database.Database;
  readonly config: Readonly<ShoggothConfig>;
  readonly configRef: { readonly current: ShoggothConfig };
  /** Register a named drain function for graceful shutdown. */
  readonly registerDrain: (name: string, fn: () => void | Promise<void>) => void;
}

interface DaemonReadyCtx {
  readonly config: Readonly<ShoggothConfig>;
  /** Map of platformId → started PlatformRuntime. */
  readonly platforms: ReadonlyMap<string, PlatformRuntime>;
}

interface DaemonShutdownCtx {
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Platform Lifecycle
// ---------------------------------------------------------------------------

interface PlatformRegisterCtx {
  readonly config: Readonly<ShoggothConfig>;
  /** Call to register a platform's URN policy and capabilities. */
  readonly registerPlatform: (reg: PlatformRegistration) => void;
  /** Call to register a platform runtime after connection. */
  readonly setPlatformRuntime: (platformId: string, runtime: PlatformRuntime) => void;
}

/** Grouped platform dependencies — keeps PlatformStartCtx readable. */
interface PlatformDeps {
  /** Access the HITL pending stack (shared across platforms). */
  readonly hitlStack: HitlPendingStack;
  /** Access the policy engine. */
  readonly policyEngine: PolicyEngine;
  /** Access the HITL config ref. */
  readonly hitlConfigRef: HitlConfigRef;
  /** Access the HITL auto-approve gate. */
  readonly hitlAutoApproveGate?: HitlAutoApproveGate;
}

interface PlatformStartCtx {
  readonly db: Database.Database;
  readonly config: Readonly<ShoggothConfig>;
  readonly configRef: { readonly current: ShoggothConfig };
  readonly env: NodeJS.ProcessEnv;
  /** Shared daemon dependencies for platform plugins. */
  readonly deps: PlatformDeps;
  /** Register a named drain function for graceful shutdown. */
  readonly registerDrain: (name: string, fn: () => void | Promise<void>) => void;
  /** Set the subagent runtime extension (runSessionModelTurn, etc.). */
  readonly setSubagentRuntimeExtension: (ext: SubagentRuntimeExtension) => void;
  /** Set the message tool context ref for builtin-message. */
  readonly setMessageToolContext: (ctx: MessageToolContext) => void;
  /** Set the platform adapter ref for the presentation layer. */
  readonly setPlatformAdapter: (adapter: PlatformAdapter) => void;
}

interface PlatformStopCtx {
  readonly platformId: string;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

interface MessageInboundCtx {
  readonly message: InternalMessage;
  readonly sessionId: string;
  readonly platformId: string;
}

/** Waterfall: plugins return a (possibly modified) outbound payload. */
interface MessageOutboundCtx {
  body: string;
  readonly sessionId: string;
  readonly platformId: string;
  readonly replyToMessageId?: string;
}

interface MessageReactionCtx {
  readonly sessionId: string;
  readonly platformId: string;
  readonly emoji: string;
  readonly userId: string;
  readonly messageId: string;
  readonly channelId: string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionTurnBeforeCtx {
  readonly sessionId: string;
  readonly userContent: string;
  readonly platformId?: string;
}

interface SessionTurnAfterCtx {
  readonly sessionId: string;
  readonly assistantText?: string;
  readonly error?: Error;
  readonly platformId?: string;
  readonly tokenUsage?: { prompt: number; completion: number };
}

interface SessionSegmentChangeCtx {
  readonly sessionId: string;
  readonly mode: "new" | "reset";
  readonly newSegmentId: string;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

interface HealthRegisterCtx {
  readonly registerProbe: (probe: HealthProbe) => void;
}

interface HealthProbe {
  readonly name: string;
  check(): Promise<HealthProbeResult>;
}

interface HealthProbeResult {
  readonly status: "pass" | "fail" | "skipped";
  readonly detail?: string;
}
```

---

## 2. `ShoggothPluginSystem`

Wraps `hooks-plugin`'s `PluginSystem` with Shoggoth's specific hook definitions.

```ts
import {
  PluginSystem,
  SyncHook,
  AsyncHook,
  SyncWaterfallHook,
  AsyncParallelHook,
  AsyncWaterfallHook,
} from "hooks-plugin";

function createShoggothHooks() {
  return {
    // Daemon lifecycle
    "daemon.configure": new SyncWaterfallHook<DaemonConfigureCtx>(),
    "daemon.startup": new AsyncHook<[DaemonStartupCtx]>(),
    "daemon.ready": new AsyncHook<[DaemonReadyCtx]>(),
    "daemon.shutdown": new AsyncHook<[DaemonShutdownCtx]>(),

    // Platform lifecycle
    "platform.register": new SyncHook<[PlatformRegisterCtx]>(),
    "platform.start": new AsyncHook<[PlatformStartCtx]>(),
    "platform.stop": new AsyncHook<[PlatformStopCtx]>(),

    // Messaging
    "message.inbound": new AsyncHook<[MessageInboundCtx]>(),
    "message.outbound": new AsyncWaterfallHook<MessageOutboundCtx>(),
    "message.reaction": new AsyncHook<[MessageReactionCtx]>(),

    // Session
    "session.turn.before": new AsyncHook<[SessionTurnBeforeCtx]>(),
    "session.turn.after": new AsyncHook<[SessionTurnAfterCtx]>(),
    "session.segment.change": new SyncHook<[SessionSegmentChangeCtx]>(),

    // Health
    "health.register": new SyncHook<[HealthRegisterCtx]>(),
  };
}

type ShoggothHooks = ReturnType<typeof createShoggothHooks>;

/** All valid hook names in the Shoggoth plugin system. */
type ShoggothHookName = keyof ShoggothHooks;

class ShoggothPluginSystem extends PluginSystem<ShoggothHooks> {
  constructor() {
    super(createShoggothHooks());
  }
}
```

---

## 3. `MessagingPlatformPlugin` Interface

Defines the required hook contract for any messaging platform plugin. This is a compile-time aid — the runtime validates via `defineMessagingPlatformPlugin` at registration time.

```ts
import type { Plugin } from "hooks-plugin";

/**
 * The minimum set of hooks a messaging platform plugin must provide.
 * Platform plugins may also implement optional hooks (message.*, session.*, etc.).
 */
interface MessagingPlatformPlugin extends Plugin<ShoggothHooks> {
  readonly name: string;
  readonly version?: string;
  hooks: {
    /** Register URN policy, capabilities, and platform runtime. */
    "platform.register": (ctx: PlatformRegisterCtx) => void;
    /** Connect to external service (gateway, API, webhook). */
    "platform.start": (ctx: PlatformStartCtx) => Promise<void>;
    /** Disconnect gracefully. */
    "platform.stop": (ctx: PlatformStopCtx) => Promise<void>;
    /** Register health probes. */
    "health.register": (ctx: HealthRegisterCtx) => void;
  };
}

const REQUIRED_MESSAGING_PLATFORM_HOOKS = [
  "platform.register",
  "platform.start",
  "platform.stop",
  "health.register",
] as const;

/**
 * Validates and returns a typed MessagingPlatformPlugin.
 * Throws if any required hook is missing.
 */
function defineMessagingPlatformPlugin(
  plugin: MessagingPlatformPlugin,
): MessagingPlatformPlugin {
  for (const hook of REQUIRED_MESSAGING_PLATFORM_HOOKS) {
    if (typeof plugin.hooks[hook] !== "function") {
      throw new Error(
        `MessagingPlatformPlugin "${plugin.name}" is missing required hook "${hook}"`,
      );
    }
  }
  return plugin;
}
```

---

## 4. Plugin Discovery Schema

Plugin metadata lives in `package.json` under a `shoggothPlugin` property bag. The loader reads `name`/`version` from the top-level fields and `kind`/`entrypoint` from `shoggothPlugin`.

```ts
import { z } from "zod";

const pluginKindSchema = z.enum([
  "messaging-platform",
  "observability",
  "general",
]);

/** Validates the `shoggothPlugin` property bag from package.json. */
const shoggothPluginBagSchema = z
  .object({
    kind: pluginKindSchema.optional().default("general"),
    entrypoint: z.string().min(1),
  })
  .strict();

type ShoggothPluginBag = z.infer<typeof shoggothPluginBagSchema>;

/** Resolved plugin metadata (combined from package.json top-level + shoggothPlugin). */
interface ShoggothPluginMeta {
  readonly name: string;
  readonly version: string;
  readonly kind: string;
  readonly entrypoint: string;
}

function parseShoggothPluginBag(data: unknown): ShoggothPluginBag {
  return shoggothPluginBagSchema.parse(data);
}

/**
 * Read a plugin's package.json and extract metadata.
 * Throws if `shoggothPlugin` is missing or invalid.
 */
function resolvePluginMeta(packageJson: Record<string, unknown>): ShoggothPluginMeta {
  const bag = parseShoggothPluginBag(packageJson.shoggothPlugin);
  return {
    name: z.string().min(1).parse(packageJson.name),
    version: z.string().min(1).parse(packageJson.version),
    kind: bag.kind,
    entrypoint: bag.entrypoint,
  };
}
```

---

## 5. Plugin Loader

The loader reads `package.json` from the plugin directory, extracts metadata via `resolvePluginMeta`, imports the entrypoint module, and calls the exported factory (or uses the default export directly) to obtain a `Plugin` object. For `messaging-platform` kind plugins, the result is validated against `MessagingPlatformPlugin` requirements before registration.

```ts
interface LoadedPluginMeta {
  readonly name: string;
  readonly version: string;
  readonly rootDir: string;
  readonly kind: string;
}

/**
 * Expected entrypoint contract:
 *
 * - Default export is a Plugin object, OR
 * - Default export is a factory function () => Plugin (or async () => Plugin)
 *
 * The loader calls the factory if it's a function, then passes the
 * resulting Plugin to pluginSystem.use().
 *
 * For kind: "messaging-platform", the plugin is validated via
 * defineMessagingPlatformPlugin before registration.
 */
async function loadPluginFromDirectory(
  rootDir: string,
  system: ShoggothPluginSystem,
): Promise<LoadedPluginMeta>;
```

---

## 6. Discord Plugin Structure

The Discord plugin exports a factory that returns a `MessagingPlatformPlugin`. Its `package.json` declares the `shoggothPlugin` bag:

```json
{
  "name": "@shoggoth/platform-discord",
  "version": "0.1.0",
  "shoggothPlugin": {
    "kind": "messaging-platform",
    "entrypoint": "./src/plugin.ts"
  }
}
```

```ts
// packages/platform-discord/src/plugin.ts

import { defineMessagingPlatformPlugin } from "@shoggoth/plugins";

/** State held across the plugin's lifecycle. */
interface DiscordPluginState {
  messaging?: DiscordMessagingRuntime;
  platform?: DiscordPlatformHandle;
  hitlNoticeRegistry?: HitlDiscordNoticeRegistry;
  reactionBotUserIdRef: { current: string | undefined };
  reactionPassthroughRef: { current: ((ev: DiscordReactionAddEvent) => void) | undefined };
}

export default function createDiscordPlugin(): MessagingPlatformPlugin {
  const state: DiscordPluginState = {
    reactionBotUserIdRef: { current: undefined },
    reactionPassthroughRef: { current: undefined },
  };

  return defineMessagingPlatformPlugin({
    name: "platform-discord",
    version: "0.1.0",
    hooks: {
      "platform.register"(ctx) {
        // Register URN policy and capabilities
        ctx.registerPlatform(discordPlatformRegistration);
      },

      async "platform.start"(ctx) {
        // All the Discord wiring currently in daemon/src/index.ts:
        // 1. Start gateway + messaging runtime
        // 2. Start Discord platform (sessions, HITL, MCP, etc.)
        // 3. Wire HITL reactions
        // 4. Wire reaction passthrough
        // 5. Set subagent runtime extension
        // 6. Set message tool context
        // 7. Set platform adapter
        // 8. Reconcile persistent subagents
        // 9. Register shutdown drains
      },

      async "platform.stop"(ctx) {
        // Disconnect gateway
        // Unsubscribe bus
        // Stop MCP runtime
        // Clear subagent extension ref
        // Clear message tool context ref
      },

      "health.register"(ctx) {
        ctx.registerProbe(createDiscordProbe({
          getToken: () => resolvedDiscordBotToken(),
        }));
      },
    },
  });
}
```

---

## 7. Daemon Boot Sequence (revised)

Pseudocode showing the new hook-driven boot:

```ts
// daemon/src/index.ts (simplified)

const pluginSystem = new ShoggothPluginSystem();

// 1. Load config
let config = loadLayeredConfig(configDir);

// 2. Fire daemon.configure (waterfall — plugins can transform config)
config = pluginSystem.lifecycle["daemon.configure"].emit({ config }).config;
const configRef = { current: config };

// 3. Open DB, migrations, bootstrap main session
const db = openStateDb(config.stateDbPath);
migrate(db, defaultMigrationsDir());
bootstrapMainSession({ db, config });

// 4. Start control plane, config hot-reload, timer scheduler, procman, etc.
// ... (unchanged)

// 5. Load plugins from config (each package.json is read for shoggothPlugin
//    metadata, entrypoint is imported, factory called, result passed to
//    pluginSystem.use())
await loadAllPluginsFromConfig({
  config,
  system: pluginSystem,
  resolveFromFile: fileURLToPath(import.meta.url),
  audit: (e) => appendAuditRow(db, pluginAuditToRow(e)),
});

// 6. Also register built-in platform plugins (Discord if enabled)
if (isPlatformEnabled(config, "discord")) {
  const discordPlugin = createDiscordPlugin();
  pluginSystem.use(discordPlugin);
}

// 7. Fire platform.register (sync)
pluginSystem.lifecycle["platform.register"].emit({
  config,
  registerPlatform: (reg) => registerMessagingPlatform(reg),
  setPlatformRuntime: (id, rt) => platformRuntimes.set(id, rt),
});

// 8. Fire health.register (sync)
pluginSystem.lifecycle["health.register"].emit({
  registerProbe: (probe) => rt.health.register(probe),
});

// 9. Fire platform.start (async)
await pluginSystem.lifecycle["platform.start"].emit({
  db, config, configRef, env: process.env,
  registerDrain: (name, fn) => rt.shutdown.registerDrain(name, fn),
  setSubagentRuntimeExtension,
  setMessageToolContext: (ctx) => { messageToolContextRef.current = ctx; },
  setPlatformAdapter: (a) => { platformAdapterRef.current = a; },
  deps: { hitlStack, policyEngine, hitlConfigRef: hitlRef, hitlAutoApproveGate },
});

// 10. Fire daemon.startup (async — general plugins)
await pluginSystem.lifecycle["daemon.startup"].emit({
  db, config, configRef,
  registerDrain: (name, fn) => rt.shutdown.registerDrain(name, fn),
});

// 11. Lock plugin system (no more registrations)
pluginSystem.lock();

// 12. Fire daemon.ready (async)
await pluginSystem.lifecycle["daemon.ready"].emit({
  config,
  platforms: platformRuntimes,
});

// Shutdown sequence
rt.shutdown.registerDrain("plugin-platform-stop", async () => {
  await pluginSystem.lifecycle["platform.stop"].emit({ platformId: "*" });
});
rt.shutdown.registerDrain("plugin-daemon-shutdown", async () => {
  await pluginSystem.lifecycle["daemon.shutdown"].emit({ reason: "shutdown" });
});
```

---

## 8. Config Schema Addition

The `ShoggothPluginEntry` type in `@shoggoth/shared` gains an optional `kind` field:

```ts
interface ShoggothPluginEntry {
  readonly id?: string;
  readonly path?: string;
  readonly package?: string;
  /** Plugin kind hint. Used for validation (e.g. messaging-platform plugins
   *  must implement required hooks). */
  readonly kind?: "messaging-platform" | "observability" | "general";
}
```

---

## 9. Error Handling

The `PluginSystem` from `hooks-plugin` provides `listenError` for centralized error handling:

```ts
pluginSystem.listenError((event) => {
  logger.error("plugin hook error", {
    hookName: event.name,
    hookType: event.type,
    pluginTag: event.tag,
    error: String(event.error),
  });
  // Audit the failure
  appendAuditRow(db, {
    source: "system",
    principalKind: "system",
    principalId: "plugin-system",
    action: "plugin.hook_error",
    resource: event.name,
    outcome: "failure",
    argsRedactedJson: JSON.stringify({
      tag: event.tag,
      type: event.type,
      error: String(event.error),
    }),
  });
});
```

Hook execution errors in `platform.start` are fatal for that platform but do not abort the daemon. The daemon logs the error and continues without that platform.

Hook execution errors in `daemon.startup` are non-fatal — logged and audited.

Hook execution errors in `daemon.shutdown` / `platform.stop` are logged but do not block shutdown.
