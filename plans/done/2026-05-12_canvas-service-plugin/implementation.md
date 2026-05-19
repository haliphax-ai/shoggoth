# Canvas Service Plugin — Implementation Steps

Phased implementation plan. Each phase is a logical unit that can be committed independently. Phases should be executed in order.

---

## Phase 1: Create feature branch and scaffold plugin package

**Branch:** `feat/canvas-service-plugin`

1. Create `packages/service-canvas/` directory
2. Write `package.json` with `shoggothPlugin` manifest, dependencies on `@shoggoth/plugins`, `@shoggoth/shared`, `express`, `ws`, `better-sqlite3`, `chokidar`, `mime-types`
3. Write `tsconfig.json` extending the project base config
4. Verify the package is recognized by the monorepo (npm workspace or equivalent)

**Commit:** `feat(canvas): scaffold @shoggoth/service-canvas plugin package`

---

## Phase 2: Port A2UI catalog packages with renamed scopes

For each of the four catalog packages:

1. Copy from the `openclaw-canvas-web` source (or create fresh)
2. Rename package from `@haliphax-openclaw/a2ui-*` to `@shoggoth/a2ui-*`
3. Update all internal imports referencing `@haliphax-openclaw/*` to `@shoggoth/*`
4. Update `catalog.json` metadata fields that reference `openclaw`
5. Verify each package typechecks independently

Packages to port:

- `packages/a2ui-sdk/` → `@shoggoth/a2ui-sdk`
- `packages/a2ui-catalog-basic/` → `@shoggoth/a2ui-catalog-basic`
- `packages/a2ui-catalog-extended/` → `@shoggoth/a2ui-catalog-extended`
- `packages/a2ui-catalog-all/` → `@shoggoth/a2ui-catalog-all`

**Commit:** `feat(canvas): port A2UI catalog packages with @shoggoth scope`

---

## Phase 3: Port server core (Express + WebSocket + routes + services)

Port the server infrastructure, replacing env vars with config, removing OpenClaw-specific components, and renaming URL schemes:

1. Copy and adapt `src/server/index.ts`:
   - Remove `NodeClient` instantiation
   - **Remove all `OPENCLAW_*` environment variable reads** — configuration comes from plugin context at startup, not env vars
   - Remove `OPENCLAW_GATEWAY_WS_URL` / `OPENCLAW_GATEWAY_TOKEN` reads
   - Remove `openclaw.json` config reading
   - Accept a `CanvasConfig` object (passed from the plugin entrypoint) for host, port, basePath, skipConfirm, a2uiDbPath, ignoreDirs, agentWorkspaces
   - `agent-proxy` and `file-spawn` route registration stays (adapted in Phase 5)
2. Copy `src/server/services/` — all files unchanged except `node-client.ts` which is **deleted**:
   - Keep: `gateway.ts`, `session-manager.ts`, `file-resolver.ts`, `file-watcher.ts`, `jsonl-watcher.ts`, `a2ui-manager.ts`, `a2ui-store.ts`, `a2ui-pipeline.ts`, `a2ui-commands.ts`, `catalog-registry.ts`
   - Delete: `node-client.ts`
3. Copy `src/server/shared/` — **`deep-link-script.ts`**: rename `openclaw://` → `shoggoth://`
4. Copy `src/server/commands/` (unchanged — handlers are reused by plugin tools)
5. Copy and adapt `src/server/routes/`:
   - Keep unchanged: `canvas.ts`, `catalogs.ts`, `canvas-config.ts`, `scaffold.ts`
   - **Adapt:** `agent-proxy.ts` — remove HTTP proxy to external gateway and gateway token; replace with call to Shoggoth's in-process sessions spawn via trusted plugin identity
   - **Adapt:** `file-spawn.ts` — same: remove HTTP proxy and gateway token, replace with in-process sessions spawn via trusted identity
6. Copy `src/client/` with URL scheme updates:
   - `url-schemes.ts`: rename all three schemes (`openclaw://` → `shoggoth://`, `openclaw-fileprompt://` → `shoggoth-fileprompt://`, `openclaw-canvas://` → `shoggoth-canvas://`)
   - `url-rewriter.ts`: update scheme references
   - `deep-link.ts`: update scheme references
   - Other client files unchanged
7. Copy `test/` — will be updated in Phase 8

**Commit:** `feat(canvas): port server core — config, WS, routes, URL schemes`

---

## Phase 4: Write plugin entrypoint

Create `packages/service-canvas/src/plugin.ts`:

1. Import `Plugin` from `hooks-plugin` and `ShoggothHooks`, `DirectServiceTool` from `@shoggoth/plugins`
2. Export default factory function `createCanvasPlugin(): Plugin<ShoggothHooks>`
3. In `service.register` hook:
   - Read canvas config from `ctx.config.services?.canvas`, merge with defaults
   - Start the Express + WebSocket server using config values (no env vars)
   - Call `ctx.registerService()` with `id: "canvas"`, `expose: "both"`, `port`, `protocol: "http+ws"`
   - Call `ctx.registerTools()` with all 8 canvas tool definitions
   - Receive `sessionsSpawn` callback from daemon context for proxy route use (trusted in-process identity — no token)
4. In `health.register` hook: register probe checking `server.listening`
5. In `daemon.shutdown` hook: graceful shutdown (close watchers, gateway, server)
6. Each tool handler delegates to the same `Gateway` instance used by the WebSocket server — no HTTP dispatch

**Commit:** `feat(canvas): implement plugin entrypoint with service + tool registration`

---

## Phase 5: Adapt proxy routes to in-process session spawn

Update the two proxy routes that handle operator-initiated subagent spawning:

1. `agent-proxy.ts`:
   - Remove the HTTP proxy logic (no more `http.request` to external gateway)
   - Remove gateway token handling (no token needed — trusted identity)
   - Replace with call to the `sessionsSpawn` function provided by the daemon context
   - Keep the same request/response format for the SPA
   - Keep the same validation (message required, optional agentId/model/thinking/timeoutSeconds)
2. `file-spawn.ts`:
   - Same adaptation: remove HTTP proxy and gateway token, call `sessionsSpawn` directly
   - Keep file reading and traversal guard logic unchanged
   - Keep the same request/response format for the SPA

**Commit:** `feat(canvas): adapt proxy routes to in-process session spawn via trusted identity`

---

## Phase 6: Port and rename documentation

For each doc file:

1. Copy from `openclaw-canvas-web/docs/` to `packages/service-canvas/docs/`
2. Replace all `openclaw` references with `shoggoth` (scope names, config paths, URL schemes)
3. Replace all `openclaw://` URL schemes with `shoggoth://` equivalents:
   - `openclaw://agent?...` → `shoggoth://agent?...`
   - `openclaw-fileprompt://` → `shoggoth-fileprompt://`
   - `openclaw-canvas://` → `shoggoth-canvas://`
4. **Replace env var config section with Shoggoth config section:**
   - Remove the `OPENCLAW_CANVAS_*` environment variable table
   - Add a `services.canvas` config section with all configurable fields and defaults
5. Remove or rewrite sections that reference:
   - OpenClaw gateway node registration
   - Ed25519 device identity
   - MCP server
   - `openclaw.json` config
6. **Update (do not remove) proxy route docs:** Describe that `/api/agent` and `/api/file-spawn` now call Shoggoth's in-process session spawn using the plugin's trusted identity, instead of HTTP-proxying to an external gateway with a token
7. Update architecture diagrams / descriptions to show Shoggoth plugin model

Docs to port:

- `README.md`
- `AGENTS.md`
- `docs/components.md`
- `docs/creating-catalog-packages.md`
- `docs/deep-linking.md`
- `docs/a2ui-reactive.md`
- `docs/jsonl-watcher.md`

**Commit:** `docs(canvas): port and rename all documentation — config, URL schemes, trusted identity`

---

## Phase 7: Create tool reference doc

Create `docs/tools/canvas.md` in the main Shoggoth docs directory:

1. Follow the existing format from other tool docs in `docs/tools/`
2. Document all 8 canvas tools: `canvas.present`, `canvas.hide`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.push`, `canvas.a2ui.pushJSONL`, `canvas.a2ui.reset`
3. Include parameter tables, example invocations, and notes on:
   - Session scoping (composite key: surfaceId + session)
   - A2UI catalog system
   - Snapshot limitations (same-origin only)
   - Deep link behavior (`shoggoth://` schemes)
   - Operator-initiated spawning via `/api/agent` and `/api/file-spawn`
   - Configuration reference (Shoggoth config, no environment variables)
   - Auth: trusted plugin identity (no token needed)

**Commit:** `docs(canvas): add tool reference doc for canvas tools`

---

## Phase 8: Adapt tests

1. Copy test files from `openclaw-canvas-web/test/`
2. Remove tests for deleted components:
   - `NodeClient` tests
   - MCP server tests
3. **Adapt proxy route tests:**
   - `agent-proxy` tests: replace mocks for external HTTP proxy + gateway token with mocks for `sessionsSpawn` callback
   - `file-spawn` tests: same adaptation
   - Verify the SPA-facing request/response format is unchanged
4. **Remove env var tests** — replace with config object tests:
   - Canvas server should accept a `CanvasConfig` object, not read from `process.env`
   - Verify defaults are applied for omitted fields
5. **Add URL scheme tests** for renamed schemes:
   - `shoggoth://` deep link parsing
   - `shoggoth-fileprompt://` file prompt parsing
   - `shoggoth-canvas://` cross-session URL rewriting
6. Update tests that mock OpenClaw gateway to mock Shoggoth plugin context instead
7. Add new tests for:
   - Plugin `service.register` hook (service entry created, tools registered, sessionsSpawn received)
   - Plugin `health.register` hook (probe registered, reports pass/fail)
   - Plugin `daemon.shutdown` hook (server stops, resources released)
   - Each of the 8 direct tool handlers
   - Config defaults applied correctly when `services.canvas` is empty or missing
8. Verify all tests pass with `vitest run`

**Commit:** `test(canvas): adapt tests for config, URL schemes, trusted identity`

---

## Phase 9: Integration verification

1. Add `{ "package": "@shoggoth/service-canvas" }` to the Shoggoth config's `plugins` array
2. Optionally add `services.canvas` config for any non-default settings
3. Build the full monorepo
4. Start the daemon — verify:
   - Plugin loads without errors
   - Service appears in `ServiceRegistry` (check `/health` or logs)
   - All 8 tools appear in `ServiceToolRegistry`
   - Canvas SPA is accessible via the gateway proxy
   - WebSocket connections work through the gateway proxy
   - Proxy routes (`/api/agent`, `/api/file-spawn`) respond correctly using trusted identity (no token)
   - Deep links use `shoggoth://` scheme
5. Run the full test suite — verify no regressions
6. Run typecheck across all affected packages

**Commit:** `feat(canvas): integrate plugin with daemon and verify end-to-end`

---

## Phase 10: Update main project docs

1. Update `docs/plugins.md` to mention the Canvas service as a reference `service`-kind plugin with trusted identity auth
2. Update `docs/daemon.md` if the service registry or gateway sections need a Canvas example
3. Add `CanvasConfig` schema to the shared config schema types
4. Update the project `AGENTS.md` or `README.md` if Canvas is listed as a component

**Commit:** `docs: reference canvas service plugin in main project docs`
