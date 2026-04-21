# @shoggoth/plugins

Plugin system for Shoggoth, built on [`hooks-plugin`](https://www.npmjs.com/package/hooks-plugin). Provides typed lifecycle hooks, plugin discovery, and a first-class `MessagingPlatformPlugin` interface for adding new messaging platforms.

## Quick Start

```ts
import {
  ShoggothPluginSystem,
  defineMessagingPlatformPlugin,
} from "@shoggoth/plugins";

const system = new ShoggothPluginSystem();

// Register a plugin
system.use({
  name: "my-plugin",
  hooks: {
    "daemon.startup": async (ctx) => {
      console.log("Plugin started");
    },
  },
});

// Fire hooks
await system.lifecycle["daemon.startup"].emit({ db, config, configRef, registerDrain });
```

## `ShoggothPluginSystem`

Extends `PluginSystem` from `hooks-plugin` with Shoggoth's 14 typed hooks pre-configured.

```ts
const system = new ShoggothPluginSystem();

// Register plugins
system.use(myPlugin);

// Fire hooks via system.lifecycle["<hookName>"].emit(ctx)
// Lock after startup to prevent late registration
system.lock();

// Centralized error handling
system.listenError((event) => {
  console.error(`Hook ${event.name} failed in plugin ${event.tag}:`, event.error);
});
```

### Config Freeze

After the `daemon.configure` waterfall, freeze the config to prevent mutation:

```ts
import { freezeConfig } from "@shoggoth/plugins";

config = system.lifecycle["daemon.configure"].emit({ config }).config;
config = freezeConfig(config);
```

## `MessagingPlatformPlugin`

Interface for messaging platform plugins. Requires four hooks:

| Required Hook | Type | Purpose |
|---|---|---|
| `platform.register` | sync | Register URN policy and capabilities |
| `platform.start` | async | Connect to external service |
| `platform.stop` | async | Disconnect gracefully |
| `health.register` | sync | Register health probes |

Use `defineMessagingPlatformPlugin` to validate at registration time:

```ts
import { defineMessagingPlatformPlugin } from "@shoggoth/plugins";

export default function createMyPlatformPlugin() {
  return defineMessagingPlatformPlugin({
    name: "platform-myservice",
    version: "0.1.0",
    hooks: {
      "platform.register"(ctx) {
        ctx.registerPlatform(myRegistration);
      },
      async "platform.start"(ctx) {
        // Connect to service, wire handlers
      },
      async "platform.stop"(ctx) {
        // Disconnect, cleanup
      },
      "health.register"(ctx) {
        ctx.registerProbe({ name: "myservice", check: async () => ({ status: "pass" }) });
      },
    },
  });
}
```

## Hook Taxonomy

All 14 hooks grouped by lifecycle phase:

### Daemon Lifecycle

| Hook | Type | Description |
|---|---|---|
| `daemon.configure` | `SyncWaterfallHook` | After config load. Plugins can inspect/transform config. Returns modified ctx. |
| `daemon.startup` | `AsyncHook` | After DB and core subsystems init. Plugins perform async setup. |
| `daemon.ready` | `AsyncHook` | After all plugins started and platforms connected. System is live. |
| `daemon.shutdown` | `AsyncHook` | Graceful shutdown. Plugins release resources. |

### Platform Lifecycle

| Hook | Type | Description |
|---|---|---|
| `platform.register` | `SyncHook` | Platforms register URN policy, capabilities, and runtime. |
| `platform.start` | `AsyncHook` | Platforms connect to external services (gateway, API, webhook). |
| `platform.stop` | `AsyncHook` | Platforms disconnect gracefully. |

### Messaging

| Hook | Type | Description |
|---|---|---|
| `message.inbound` | `AsyncHook` | A normalized inbound message is ready for dispatch. |
| `message.outbound` | `AsyncWaterfallHook` | Outbound message about to be delivered. Plugins can transform content. |
| `message.reaction` | `AsyncHook` | A reaction event is received from a platform. |

### Session

| Hook | Type | Description |
|---|---|---|
| `session.turn.before` | `AsyncHook` | Before a model turn executes. |
| `session.turn.after` | `AsyncHook` | After a model turn completes (success or failure). |
| `session.segment.change` | `SyncHook` | A session's context segment changes (new/reset). |

### Health

| Hook | Type | Description |
|---|---|---|
| `health.register` | `SyncHook` | Plugins register health probes during startup. |

## Plugin Discovery

Plugin metadata lives in `package.json` under a `shoggothPlugin` property bag (no separate manifest file):

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

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `"messaging-platform" \| "observability" \| "general"` | No | Plugin kind. Defaults to `"general"`. `messaging-platform` plugins are validated against `MessagingPlatformPlugin`. |
| `entrypoint` | `string` | Yes | Path to the module that exports the plugin factory or plugin object. |

`name` and `version` are read from the top-level `package.json` fields.

The loader (`loadPluginFromDirectory`) reads `package.json`, extracts metadata via `resolvePluginMeta`, imports the entrypoint, calls the exported factory (if it's a function), and passes the resulting `Plugin` to `pluginSystem.use()`.

## Example Plugin Structure

```
my-plugin/
├── package.json
└── src/
    └── plugin.ts
```

**package.json:**
```json
{
  "name": "shoggoth-plugin-logger",
  "version": "1.0.0",
  "shoggothPlugin": {
    "kind": "observability",
    "entrypoint": "./src/plugin.ts"
  }
}
```

**src/plugin.ts:**
```ts
import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "@shoggoth/plugins";

export default function createLoggerPlugin(): Plugin<ShoggothHooks> {
  return {
    name: "logger",
    hooks: {
      "session.turn.before": async (ctx) => {
        console.log(`[turn] session=${ctx.sessionId} content=${ctx.userContent}`);
      },
      "session.turn.after": async (ctx) => {
        console.log(`[turn] session=${ctx.sessionId} tokens=${ctx.tokenUsage?.completion}`);
      },
    },
  };
}
```

**Referencing in config:**
```json
{
  "plugins": [
    { "path": "./plugins/my-plugin" },
    { "package": "shoggoth-plugin-logger" }
  ]
}
```

## Exports

```ts
// Plugin system
ShoggothPluginSystem, createShoggothHooks, freezeConfig
type ShoggothHooks, ShoggothHookName

// Platform plugin interface
defineMessagingPlatformPlugin, REQUIRED_MESSAGING_PLATFORM_HOOKS
type MessagingPlatformPlugin

// Hook context types
type DaemonConfigureCtx, DaemonStartupCtx, DaemonReadyCtx, DaemonShutdownCtx
type PlatformRegisterCtx, PlatformDeps, PlatformStartCtx, PlatformStopCtx
type MessageInboundCtx, MessageOutboundCtx, MessageReactionCtx
type SessionTurnBeforeCtx, SessionTurnAfterCtx, SessionSegmentChangeCtx
type HealthRegisterCtx, HealthProbe, HealthProbeResult

// Plugin discovery & loading
loadPluginFromDirectory, loadAllPluginsFromConfig
resolvePluginMeta, parseShoggothPluginBag, shoggothPluginBagSchema
type ShoggothPluginMeta, ShoggothPluginBag
type LoadedPluginMeta, LoadedPluginRef, PluginAuditEvent
```
