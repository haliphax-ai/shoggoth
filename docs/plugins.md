# Plugins Reference (`@shoggoth/plugins`)

This document is a source-level reference for the `@shoggoth/plugins` package. Plugins are loadable extension packages that hook into the [daemon](daemon.md) lifecycle via a central hook registry.

---

## Overview

Plugins are loadable extension packages (local directories or npm packages) that register hook handlers into a central `HookRegistry`, allowing code to run at defined lifecycle points (e.g. daemon startup/shutdown).

Key characteristics:

- Each plugin is a directory containing a `shoggoth.json` manifest.
- The manifest declares which hooks the plugin handles and points to the handler modules.
- Hook handlers are plain functions (sync or async) that are `default`-exported from their module.
- Plugins are loaded at daemon startup and their hooks are executed sequentially in registration (FIFO) order.
- Loading failures are audited but do not abort the loading of other plugins.

---

## Plugin Manifest (`shoggoth.json`)

Every plugin directory must contain a `shoggoth.json` file at its root. The manifest is validated with a strict Zod schema:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "hooks": {
    "daemon.startup": "./hooks/startup.js",
    "daemon.shutdown": "./hooks/shutdown.js"
  }
}
```

### Manifest Fields

| Field     | Type                          | Required | Description |
|-----------|-------------------------------|----------|-------------|
| `name`    | `string`                      | Yes      | Plugin name (non-empty). |
| `version` | `string`                      | Yes      | Plugin version (non-empty). |
| `hooks`   | `Record<HookName, string>`    | No       | Map of hook names to relative file paths. Each file must default-export a function. |

The schema is **strict** — unknown fields cause validation failure.

---

## Supported Hook Names (v1)

| Hook Name          | When It Fires |
|--------------------|---------------|
| `daemon.startup`   | When the Shoggoth daemon starts up. |
| `daemon.shutdown`  | When the Shoggoth daemon shuts down. |

The `HookName` type is the union of these string literals.

---

## Plugin Loading

Plugins are loaded by `loadPluginFromDirectory()`:

1. Read and parse `shoggoth.json` from the plugin's root directory.
2. Validate the manifest against the strict Zod schema.
3. For each entry in `hooks`:
   - Resolve the relative path to an absolute file URL.
   - Dynamically `import()` the module.
   - Verify the module's `default` export is a function.
   - Register the function as a handler in the `HookRegistry`.
4. Return `LoadedPluginMeta` (`name`, `version`, `rootDir`).

If the default export is not a function, loading throws an error.

```typescript
interface LoadedPluginMeta {
  readonly name: string;
  readonly version: string;
  readonly rootDir: string;
}
```

---

## Plugin Resolution (Config-Driven)

`loadAllPluginsFromConfig()` iterates over `config.plugins` entries. Each entry can specify a plugin by:

- **Local path** (`entry.path`): Resolved relative to `config.configDirectory`. Absolute paths are used as-is.
- **npm package** (`entry.package`): Resolved via `createRequire()` from a reference file, locating the package's `package.json` and using its parent directory as the plugin root.

### Resolution Helpers

| Function | Purpose |
|----------|---------|
| `resolveLocalPluginPath(entry, configDir)` | Resolves a local path entry relative to the config directory. |
| `resolveNpmPluginRoot(entry)` | Resolves an npm package entry to its root directory via `createRequire()`. |

### Audit Events

Each plugin load attempt is audited:

```typescript
interface PluginAuditEvent {
  readonly action: "plugin.load" | "plugin.unload";
  readonly resource: string;       // entry.id ?? entry.path ?? entry.package ?? "unknown"
  readonly outcome: "success" | "failure";
  readonly detail?: string;        // Error message on failure
}
```

Loading failures are caught and audited — they do **not** abort the loading of subsequent plugins.

Successfully loaded plugins are returned as `LoadedPluginRef[]`:

```typescript
interface LoadedPluginRef {
  readonly resource: string;
  readonly manifestName: string;
}
```

---

## Hook Registry

The `HookRegistry` is the central dispatch mechanism for plugin hooks.

```typescript
type HookName = "daemon.startup" | "daemon.shutdown";
type HookHandler = (ctx?: unknown) => void | Promise<void>;
```

### API

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `register(name: HookName, handler: HookHandler)` | Append a handler for the given hook. Multiple handlers per hook are supported. |
| `run` | `run(name: HookName, ctx?: unknown)` | Execute all handlers for a hook **sequentially** in registration order, awaiting each. An optional context object is passed to every handler. |
| `clear` | `clear(name: HookName)` | Remove all handlers for a specific hook (e.g. during plugin unload). |
| `reset` | `reset()` | Remove all handlers for all hooks. |

### Execution Model

- Handlers are executed in FIFO order (the order they were registered).
- Each handler is `await`ed before the next runs — there is no parallel execution.
- An optional context object passed to `run()` is forwarded to every handler.

---

## Package Exports

The public API exported from `@shoggoth/plugins`:

```typescript
// Plugin loading (config-driven)
loadAllPluginsFromConfig, resolveLocalPluginPath, resolveNpmPluginRoot
type LoadedPluginRef, PluginAuditEvent, PluginAuditOutcome

// Hook system
HookRegistry
type HookHandler, HookName

// Single-plugin loader
loadPluginFromDirectory
type LoadedPluginMeta

// Plugin manifest
parseShoggothPluginManifest, shoggothPluginManifestSchema
type ShoggothPluginManifest
```

---

## Quick-Start Examples

### Writing a Plugin

1. Create a directory with a `shoggoth.json`:

```json
{
  "name": "my-startup-plugin",
  "version": "0.1.0",
  "hooks": {
    "daemon.startup": "./on-startup.js"
  }
}
```

2. Create the hook handler file (`on-startup.js`):

```javascript
export default async function onStartup(ctx) {
  console.log("Shoggoth daemon is starting up!");
}
```

### Referencing in Config

Reference a local plugin by path:

```json
{
  "plugins": [
    { "path": "./plugins/my-startup-plugin" }
  ]
}
```

Or reference an npm-published plugin by package name:

```json
{
  "plugins": [
    { "package": "shoggoth-plugin-example" }
  ]
}
```

### Multi-Hook Plugin

A plugin can register handlers for multiple lifecycle hooks:

```json
{
  "name": "lifecycle-logger",
  "version": "1.0.0",
  "hooks": {
    "daemon.startup": "./hooks/startup.js",
    "daemon.shutdown": "./hooks/shutdown.js"
  }
}
```

```javascript
// hooks/startup.js
export default async function onStartup(ctx) {
  console.log("[lifecycle-logger] daemon started");
}
```

```javascript
// hooks/shutdown.js
export default async function onShutdown(ctx) {
  console.log("[lifecycle-logger] daemon shutting down");
}
```

---

## See Also

- [Daemon](daemon.md) — loads plugins at startup and runs hook handlers
- [Skills](skills.md) — skill discovery and search (previously co-located with plugins)
- [Shared](shared.md) — `ShoggothPluginEntry` config schema
