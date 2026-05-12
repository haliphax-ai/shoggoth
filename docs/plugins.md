# Plugins Reference (`@shoggoth/plugins`)

The Shoggoth plugin system is built on [`hooks-plugin`](https://www.npmjs.com/package/hooks-plugin), providing typed lifecycle hooks that plugins tap into to extend daemon behavior. Plugins can observe events, transform data via waterfall hooks, and register entirely new messaging platforms.

---

## Overview

Plugins are loadable extension packages (local directories or npm packages) that register hook handlers into a `ShoggothPluginSystem`. The system defines 14 typed hooks spanning daemon lifecycle, platform lifecycle, messaging, session, and health.

Key characteristics:

- Plugin metadata lives in `package.json` under a `shoggothPlugin` property bag — no separate manifest file.
- The entrypoint exports a plugin object or a factory function that returns one.
- Hooks are strongly typed — each hook has a defined context type.
- Waterfall hooks (`daemon.configure`, `message.outbound`) allow plugins to transform data in a pipeline.
- Plugins fire in registration order (FIFO). The system can be locked after startup to prevent late registration.
- Loading failures are audited but do not abort the loading of other plugins.

---

## How to Create a Plugin

### 1. Set up `package.json`

```json
{
  "name": "shoggoth-plugin-example",
  "version": "1.0.0",
  "shoggothPlugin": {
    "kind": "general",
    "entrypoint": "./src/plugin.ts"
  }
}
```

The `shoggothPlugin` property bag fields:

| Field        | Type                                                   | Required | Description                                                                                   |
| ------------ | ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------- |
| `kind`       | `"messaging-platform" \| "observability" \| "general"` | No       | Defaults to `"general"`. `messaging-platform` plugins must implement required platform hooks. |
| `entrypoint` | `string`                                               | Yes      | Module that exports the plugin factory or plugin object.                                      |

### 2. Write the plugin entrypoint

Export a factory function (or a plugin object directly):

```ts
import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "@shoggoth/plugins";

export default function createMyPlugin(): Plugin<ShoggothHooks> {
  return {
    name: "my-plugin",
    hooks: {
      "daemon.startup": async (ctx) => {
        console.log("Plugin initialized with config:", ctx.config);
      },
      "daemon.shutdown": async (ctx) => {
        console.log("Shutting down:", ctx.reason);
      },
    },
  };
}
```

### 3. Reference in config

By local path (resolved relative to config directory):

```json
{
  "plugins": [{ "path": "./plugins/shoggoth-plugin-example" }]
}
```

By npm package name:

```json
{
  "plugins": [{ "package": "shoggoth-plugin-example" }]
}
```

---

## Hook Catalog

### Daemon Lifecycle

| Hook               | Type                | Context              | Description                                                                       |
| ------------------ | ------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `daemon.configure` | `SyncWaterfallHook` | `DaemonConfigureCtx` | After config load, before subsystems start. Plugins can inspect/transform config. |
| `daemon.startup`   | `AsyncHook`         | `DaemonStartupCtx`   | After DB and core subsystems init. Plugins perform async setup.                   |
| `daemon.ready`     | `AsyncHook`         | `DaemonReadyCtx`     | All plugins started, platforms connected. System is live.                         |
| `daemon.shutdown`  | `AsyncHook`         | `DaemonShutdownCtx`  | Graceful shutdown. Plugins release resources.                                     |

### Platform Lifecycle

| Hook                | Type        | Context               | Description                                                     |
| ------------------- | ----------- | --------------------- | --------------------------------------------------------------- |
| `platform.register` | `SyncHook`  | `PlatformRegisterCtx` | Platforms register URN policy, capabilities, and runtime.       |
| `platform.start`    | `AsyncHook` | `PlatformStartCtx`    | Platforms connect to external services (gateway, API, webhook). |
| `platform.stop`     | `AsyncHook` | `PlatformStopCtx`     | Platforms disconnect gracefully.                                |

### Messaging

| Hook               | Type                 | Context              | Description                                                            |
| ------------------ | -------------------- | -------------------- | ---------------------------------------------------------------------- |
| `message.inbound`  | `AsyncHook`          | `MessageInboundCtx`  | Normalized inbound message ready for dispatch.                         |
| `message.outbound` | `AsyncWaterfallHook` | `MessageOutboundCtx` | Outbound message about to be delivered. Plugins can transform content. |
| `message.reaction` | `AsyncHook`          | `MessageReactionCtx` | Reaction event received from a platform.                               |

### Session

| Hook                     | Type        | Context                   | Description                                        |
| ------------------------ | ----------- | ------------------------- | -------------------------------------------------- |
| `session.turn.before`    | `AsyncHook` | `SessionTurnBeforeCtx`    | Before a model turn executes.                      |
| `session.turn.after`     | `AsyncHook` | `SessionTurnAfterCtx`     | After a model turn completes (success or failure). |
| `session.segment.change` | `SyncHook`  | `SessionSegmentChangeCtx` | Session context segment changes (new/reset).       |

### Health

| Hook              | Type       | Context             | Description                                    |
| ----------------- | ---------- | ------------------- | ---------------------------------------------- |
| `health.register` | `SyncHook` | `HealthRegisterCtx` | Plugins register health probes during startup. |

### Hook Types Explained

- `SyncHook` — synchronous, fire-and-forget. Handlers run in order, no return value.
- `AsyncHook` — async sequential. Each handler is awaited before the next runs.
- `SyncWaterfallHook` — synchronous pipeline. Each handler receives the context and returns a (possibly modified) version for the next handler.
- `AsyncWaterfallHook` — async pipeline. Same as waterfall but handlers can be async.

---

## Platform Plugin Guide

To add a new messaging platform (e.g. Slack, Telegram), create a plugin with `kind: "messaging-platform"` and implement the four required hooks.

### Required Hooks

| Hook                | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `platform.register` | Register URN policy and platform capabilities          |
| `platform.start`    | Connect to the external service, wire message handlers |
| `platform.stop`     | Disconnect and clean up resources                      |
| `health.register`   | Register a health probe for the platform               |

### Example

```ts
import { defineMessagingPlatformPlugin } from "@shoggoth/plugins";

export default function createSlackPlugin() {
  let client: SlackClient | undefined;

  return defineMessagingPlatformPlugin({
    name: "platform-slack",
    version: "0.1.0",
    hooks: {
      "platform.register"(ctx) {
        ctx.registerPlatform({
          id: "slack",
          urnPattern: /^slack:/,
          // ... capabilities
        });
      },

      async "platform.start"(ctx) {
        client = new SlackClient(ctx.env.SLACK_TOKEN);
        await client.connect();
        ctx.registerDrain("slack-disconnect", () => client?.disconnect());
      },

      async "platform.stop"(ctx) {
        await client?.disconnect();
        client = undefined;
      },

      "health.register"(ctx) {
        ctx.registerProbe({
          name: "slack",
          check: async () => ({
            status: client?.connected ? "pass" : "fail",
          }),
        });
      },
    },
  });
}
```

**package.json:**

```json
{
  "name": "@shoggoth/platform-slack",
  "version": "0.1.0",
  "shoggothPlugin": {
    "kind": "messaging-platform",
    "entrypoint": "./src/plugin.ts"
  }
}
```

`defineMessagingPlatformPlugin` validates that all four required hooks are present at registration time and throws if any are missing.

### `PlatformStartCtx` Dependencies

The `platform.start` context provides shared daemon dependencies via `ctx.deps`:

| Dependency            | Type                   | Description                     |
| --------------------- | ---------------------- | ------------------------------- |
| `hitlStack`           | `HitlPendingStack`     | Shared HITL pending stack       |
| `policyEngine`        | `PolicyEngine`         | Policy engine access            |
| `hitlConfigRef`       | `HitlConfigRef`        | HITL configuration reference    |
| `hitlAutoApproveGate` | `HitlAutoApproveGate?` | Optional HITL auto-approve gate |

Additional setters on the context: `setSubagentRuntimeExtension`, `setMessageToolContext`, `setPlatformAdapter`.

---

## Service Plugin Guide

To add an in-process service that registers tools directly (no HTTP gateway required), create a plugin with `kind: "service"`.

### Required Hooks

| Hook               | Purpose                                                 |
| ------------------ | ------------------------------------------------------- |
| `daemon.configure` | Inspect/transform config, set up service initialization |
| `service.register` | Register the service and its tools in the registry      |
| `daemon.shutdown`  | Clean up resources on shutdown                          |
| `health.register`  | Register a health probe for the service                 |

### Example

```ts
import { defineServicePlugin } from "@shoggoth/plugins";

export default function createCanvasService() {
  let state: CanvasState | undefined;

  return defineServicePlugin({
    name: "service-canvas",
    version: "0.1.0",
    hooks: {
      "daemon.configure"(ctx) {
        // Optionally transform config or set defaults
        return ctx;
      },

      async "service.register"(ctx) {
        ctx.registerService({
          id: "canvas",
          label: "Canvas Service",
          capabilities: ["drawing", "rendering"],
        });

        ctx.registerTools([
          {
            name: "canvas.push",
            description: "Push a drawing operation to the canvas",
            parameters: {
              type: "object",
              properties: {
                operation: { type: "string" },
                data: { type: "object" },
              },
              required: ["operation", "data"],
            },
            handler: async (args, ctx) => {
              // Direct handler - runs in-process with the daemon
              state = pushOperation(state, args.operation, args.data);
              return { resultJson: JSON.stringify({ success: true, state }) };
            },
          },
        ]);
      },

      async "daemon.shutdown"(ctx) {
        // Clean up resources
        state = undefined;
      },

      "health.register"(ctx) {
        ctx.registerProbe({
          name: "canvas",
          check: async () => ({
            status: state ? "pass" : "fail",
          }),
        });
      },
    },
  });
}
```

**package.json:**

```json
{
  "name": "@shoggoth/service-canvas",
  "version": "0.1.0",
  "shoggothPlugin": {
    "kind": "service",
    "entrypoint": "./src/plugin.ts"
  }
}
```

`defineServicePlugin` validates that all four required hooks are present at registration time and throws if any are missing.

### Direct Tool Dispatch

Tools registered via `registerTools` use direct dispatch — the handler function is called in-process without HTTP requests or auth token handling. This is ideal for:

- Lightweight services that don't need a separate process
- Services that benefit from shared memory with the daemon
- Rapid prototyping before extracting to a full microservice

### Overriding Defaults

Plugin defaults can be overridden via the `services[]` config:

```json
{
  "services": [
    {
      "id": "canvas",
      "port": 3001,
      "basePath": "/api"
    }
  ]
}
```

This allows a service plugin to optionally bind an HTTP listener while still providing direct tool dispatch for internal use.

### Demo Service Plugin (`@shoggoth/service-demo`)

A minimal proof-of-concept service plugin is included in the repo at `packages/service-demo`. It starts an HTTP server displaying an in-memory string and exposes two tools for agents to read and change it.

**Enabling the demo plugin:**

Add it to your `plugins` array in config:

```json
{
  "plugins": [{ "package": "@shoggoth/platform-discord" }, { "package": "@shoggoth/service-demo" }]
}
```

**Enabling the gateway (optional):**

To access the demo service via the HTTP gateway proxy, add a `gateway` block:

```json
{
  "gateway": {
    "enabled": true,
    "port": 8000
  }
}
```

The demo page will then be available at `http://localhost:8000/svc/demo/`. Without the gateway, it's accessible directly at `http://127.0.0.1:3200/`.

**Agent tools provided:**

| Tool               | Description                                 |
| ------------------ | ------------------------------------------- |
| `demo.set_message` | Set the message displayed on the demo page. |
| `demo.get_message` | Get the current message.                    |

**Testing it out:**

1. Add the plugin to config and restart the daemon.
2. Visit `http://127.0.0.1:3200/` to see the default message.
3. Have an agent call `demo.set_message` with a new message string.
4. Refresh the page to see the updated message.

This plugin serves as a reference for building service plugins. It demonstrates the full lifecycle: `daemon.configure` → `service.register` (with HTTP server + direct tools) → `health.register` → `daemon.shutdown`.

## Error Handling

The `ShoggothPluginSystem` provides centralized error handling via `listenError`:

```ts
system.listenError((event) => {
  logger.error("Plugin hook error", {
    hookName: event.name,
    hookType: event.type,
    pluginTag: event.tag,
    error: String(event.error),
  });
});
```

Error behavior by hook:

| Hook Phase                          | Behavior                                             |
| ----------------------------------- | ---------------------------------------------------- |
| `platform.start`                    | Fatal for that platform, daemon continues without it |
| `daemon.startup`                    | Non-fatal — logged and audited                       |
| `daemon.shutdown` / `platform.stop` | Logged, does not block shutdown                      |

---

## See Also

- [Daemon](daemon.md) — boot sequence and plugin loading
- [Discord Platform](platform-discord.md) — reference platform plugin implementation
- [Shared](shared.md) — `ShoggothPluginEntry` config schema
