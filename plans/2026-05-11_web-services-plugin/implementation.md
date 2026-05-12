# Implementation

## Phase 1: Service Declaration, Registry & Plugin Hook

Extend the config schema to support all three service tiers (plugin, managed, external), build the runtime registry, and add the `service.register` hook to the plugin system. This is the foundation everything else builds on.

- ✅ Add `serviceDeclarationSchema` to `@shoggoth/shared` as an optional field on `processDeclarationSchema`
- ✅ Add `externalServiceDeclarationSchema` and top-level `services[]` config key
- ✅ Add `"service"` to the plugin kind enum in `@shoggoth/shared`
- ✅ Add `service.register` hook to `ShoggothPluginSystem` (AsyncHook with `ServiceRegisterCtx`)
- ✅ Create `ServiceRegistry` class in the daemon (`src/service-registry.ts`)
- Wire registry to procman events for managed services: `process-started` → register, `process-stopped` / `process-failed` → deregister
- For external services, implement a health check polling loop (configurable interval) that registers/deregisters based on reachability
- ✅ For plugin services, registration happens directly via the `service.register` hook during startup
- ✅ Populate `ServiceEntry.url` from declaration's host + port + basePath (null for portless plugin services)
- ✅ Add `tier` field to `ServiceEntry` ("plugin" | "managed" | "external")
- Add config validation: detect port/ID conflicts across all three tiers at load time
- ✅ All tiers produce the same `ServiceEntry` in the registry — downstream consumers don't need to know the difference

**Files:**

- ✅ `packages/shared/src/schema.ts` — add `serviceDeclarationSchema`, `externalServiceDeclarationSchema`, extend `processDeclarationSchema`, add `"service"` plugin kind
- ✅ `packages/plugins/src/hook-types.ts` — add `ServiceRegisterCtx` type
- ✅ `packages/plugins/src/plugin-system.ts` — add `service.register` hook
- ✅ `packages/daemon/src/service-registry.ts` — new `ServiceRegistry` class with health polling for external services
- `packages/daemon/src/service-registry.test.ts` — unit tests covering all three tiers
- ✅ `packages/daemon/src/index.ts` — instantiate registry, subscribe to procman events, fire `service.register` hook, start external health polling

## Phase 2: Tool Registry Extension (Direct + HTTP Dispatch)

Extend the tool registry to support two dispatch modes: direct function calls (plugin services) and HTTP proxy (managed/external services). This must be in place before manifest fetching or plugin tool registration can work.

- ✅ Create `ServiceToolRegistry` that supports both `registerDirectTool` and `registerHttpTool`
- ✅ Direct tools store a handler function reference — invoked in-process with no network hop
- ✅ HTTP tools store the `ServiceToolDeclaration` — dispatched via HTTP proxy with auth tokens
- ✅ Unified `dispatch()` method that routes based on tool registration kind
- ✅ Deregistration by service ID (removes all tools for a service)
- Tool name collision detection (across services and with builtin tools)
- Wire tool registry to `ServiceRegistry` events: on deregistration/unhealthy → remove tools; on healthy → re-register

**Files:**

- ✅ `packages/daemon/src/service-tool-registry.ts` — new `ServiceToolRegistry` class
- `packages/daemon/src/service-tool-registry.test.ts` — unit tests for both dispatch modes
- ✅ `packages/daemon/src/sessions/builtin-tool-registry.ts` — extend to support dynamic service tool registration/deregistration

## Phase 3: Auth — Per-Service Age Identities with Operator Approval

Implement the service registration and approval flow via the operator CLI. Each approved managed/external service gets a unique age X25519 identity. Plugin services are exempt (trusted in-process code).

- Add `shoggoth service register <id>` CLI command — submits a registration request (does not auto-approve)
- Add `shoggoth service requests` CLI command — lists service IDs with pending registration/scope-change requests
- Add `shoggoth service request <id>` CLI command — displays full details of a pending request (requested ops, capabilities, manifest info)
- Add `shoggoth service approve <id>` CLI command — approves the request, generates age identity on confirmation
- Add `shoggoth service rotate-key <id>` CLI command — generates new identity, displays new private key for the service
- Add `shoggoth service list` and `shoggoth service revoke <id>` CLI commands
- `shoggoth service list` shows all services across all tiers; plugin services show as "approved (plugin)" since they don't need explicit approval
- ✅ Implement `ServiceKeyStore` — stores recipients (public keys) in the daemon's credential store, keyed by service ID
- ✅ Implement `TokenMinter` — age-encrypted base64url payloads with agent ID, scope, expiry (encrypted to the service's recipient)
- ✅ Implement `TokenValidator` — decrypt with age identity, check expiry, decode payload (for use in `@shoggoth/service-auth` helper package)
- Service receives its identity (private key) once at registration time (displayed by CLI or written to a path)
- Managed/external services declared in config with no approved identity are started by procman but cannot receive authenticated tool requests until approved
- ✅ Plugin services skip the approval flow entirely — they're trusted code
- ✅ Reuses the existing `age-encryption` library already used by the vault system

**Files:**

- ✅ `packages/daemon/src/service-key-store.ts` — identity generation, recipient storage, retrieval
- ✅ `packages/daemon/src/service-auth.ts` — `TokenMinter` implementation
- `packages/daemon/src/service-auth.test.ts` — unit tests for key generation, mint/validate round-trip
- `packages/cli/src/commands/service.ts` — CLI commands for register, rotate-key, list, revoke
- `packages/service-auth/` — optional standalone validation package for managed/external service authors

## Phase 4: Manifest Fetching & HTTP Tool Registration

When a managed/external service becomes healthy, fetch its manifest and dynamically register its declared tools as HTTP proxy handlers. Plugin services skip this entirely (they register tools directly in Phase 1/2).

- ✅ Fetch `GET {serviceUrl}{manifestPath}` on service registration (managed/external only)
- ✅ Validate manifest response against `serviceManifestSchema`
- ✅ For each tool in `manifest.tools[]`, register an HTTP proxy handler via `ServiceToolRegistry.registerHttpTool()`
- ✅ HTTP tool handler: resolves service URL, mints token, builds HTTP request from tool declaration + args, returns response
- ✅ On service deregistration or health failure, remove all tools for that service
- ✅ Handle manifest fetch failures gracefully (log warning, service still registered but no tools)
- ✅ Tool names are namespaced (e.g. `canvas.push`) to avoid collisions

**Files:**

- ✅ `packages/daemon/src/service-tool-dispatcher.ts` — HTTP dispatch logic for managed/external service tools
- `packages/daemon/src/service-tool-dispatcher.test.ts` — unit tests
- ✅ `packages/daemon/src/service-registry.ts` — add manifest fetch + tool lifecycle hooks (managed/external only)

## Phase 5: HTTP Gateway

A reverse proxy that provides a single external entry point for all gateway-exposed services (any tier that binds a port and sets `expose: "gateway"` or `"both"`).

- ✅ Implement gateway as an optional daemon subsystem (enabled via `gateway` config key)
- ✅ Path-based routing: `/{prefix}/{serviceId}/{path}` → service URL + path
- Auth enforcement: require valid Shoggoth token on all proxied requests (configurable per-service)
- ✅ Plugin services that bind a port can opt into gateway routing just like managed/external services
- ✅ CORS handling based on gateway config
- ✅ WebSocket upgrade support for `http+ws` services
- ✅ Register gateway shutdown drain (close listener, drain active connections)
- Health endpoint on gateway itself (`GET /{prefix}/_health`)

**Files:**

- ✅ `packages/shared/src/schema.ts` — add `gatewayConfigSchema` to top-level config
- ✅ `packages/daemon/src/gateway.ts` — HTTP gateway implementation
- `packages/daemon/src/gateway.test.ts` — integration tests with mock services
- ✅ `packages/daemon/src/index.ts` — conditional gateway startup, shutdown drain registration

## Phase 6: Scoped Control Plane Access for Services

Enable managed/external services to interact with Shoggoth beyond responding to tool calls. Plugin services already have direct access to daemon internals via `ServiceRegisterCtx.deps` and don't need control plane connections.

- Add service authentication to the control plane — managed/external services connect and prove identity with their key pair
- Implement scope enforcement — each control plane operation is checked against the service's approved `ops` list
- Service manifest declares requested operations in an `ops[]` field
- `shoggoth service register` and `shoggoth service approve` display and gate the requested scope
- Scope stored alongside the key pair in the credential store
- Rate limiting per-service to prevent abuse (configurable per operation or globally)
- Connection lifecycle: service connects at startup, daemon drops connection on service deregistration or revocation
- Plugin services access the same operations directly via `deps` — no connection or scope enforcement needed (they're trusted)

**Files:**

- `packages/daemon/src/control-plane/service-auth.ts` — authenticate managed/external service connections, enforce scope
- `packages/daemon/src/control-plane/service-auth.test.ts` — tests for auth + scope enforcement
- `packages/daemon/src/service-key-store.ts` — extend to store approved ops alongside key pair
- `packages/cli/src/commands/service.ts` — update register/approve to handle scope display and confirmation

## Future: Canvas Web Port (First Consumer)

The Canvas Web port will be done as a separate project. It serves as the first real consumer of this plugin system and will validate the spec end-to-end. It can start as a **plugin service** (fastest iteration, no auth overhead, direct tool handlers) and later be extracted to a managed process if isolation or language flexibility is needed.

The migration path from plugin → managed process is seamless:

1. Extract the service code to its own package/process
2. Add a manifest endpoint
3. Remove the plugin from `plugins[]`, add the process to `processes[]` with a `service` block
4. Run `shoggoth service approve <id>` to set up auth

Agents don't notice the change — the tool interface and registry entry are identical.
