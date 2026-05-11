# Implementation

## Phase 1: Service Declaration & Registry

Extend the config schema to support service declarations and build the runtime registry that tracks healthy services. No external-facing changes yet — this is the foundation.

- Add `serviceDeclarationSchema` to `@shoggoth/shared` as an optional field on `processDeclarationSchema`
- Create `ServiceRegistry` class in the daemon (`src/service-registry.ts`)
- Wire registry to procman events: `process-started` → register, `process-stopped` / `process-failed` → deregister
- Populate `ServiceEntry.url` from declaration's host + port + basePath
- Add config validation: detect port conflicts across service declarations at load time

**Files:**

- `packages/shared/src/schema.ts` — add `serviceDeclarationSchema`, extend `processDeclarationSchema`
- `packages/daemon/src/service-registry.ts` — new `ServiceRegistry` class
- `packages/daemon/src/service-registry.test.ts` — unit tests
- `packages/daemon/src/index.ts` — instantiate registry, subscribe to procman events

## Phase 2: Auth — Per-Service Key Pairs with Operator Approval

Implement the service registration and approval flow via the operator CLI. Each approved service gets a unique Ed25519 key pair. The daemon signs tokens with the private key; the service validates with its public key.

- Add `shoggoth service register <id>` CLI command — prompts operator for approval, generates Ed25519 key pair on confirmation
- Add `shoggoth service rotate-key <id>` CLI command — generates new key pair, displays new public key
- Add `shoggoth service list` and `shoggoth service revoke <id>` CLI commands
- Implement `ServiceKeyStore` — stores private keys in the daemon's credential store, keyed by service ID
- Implement `TokenMinter` — Ed25519-signed base64url payloads with agent ID, scope, expiry
- Implement `TokenValidator` — verify Ed25519 signature, check expiry, decode payload (for use in `@shoggoth/service-auth` helper package)
- Service receives its public key once at registration time (displayed by CLI or written to a path)
- Services declared in config with no approved key pair are started by procman but cannot receive authenticated tool requests until approved

**Files:**

- `packages/daemon/src/service-key-store.ts` — key pair generation, storage, retrieval
- `packages/daemon/src/service-auth.ts` — `TokenMinter` implementation
- `packages/daemon/src/service-auth.test.ts` — unit tests for key generation, mint/validate round-trip
- `packages/cli/src/commands/service.ts` — CLI commands for register, rotate-key, list, revoke
- `packages/service-auth/` — optional standalone validation package for service authors

## Phase 3: Manifest Fetching & Plugin Tool Registration

When a service becomes healthy, fetch its manifest and dynamically register its declared tools with the agent tool system. When it goes unhealthy or stops, deregister them.

- Fetch `GET {serviceUrl}{manifestPath}` on service registration
- Validate manifest response against `serviceManifestSchema`
- For each tool in `manifest.tools[]`, register a handler in the builtin tool registry
- Tool handler is a generic dispatcher: resolves service URL, mints token, builds HTTP request from tool declaration + args, returns response
- On service deregistration or health failure, remove all tools for that service
- Handle manifest fetch failures gracefully (log warning, service still registered but no tools)
- Tool names are namespaced (e.g. `canvas.push`) to avoid collisions

**Files:**

- `packages/daemon/src/service-tool-dispatcher.ts` — generic dispatch logic for service-provided tools
- `packages/daemon/src/service-tool-dispatcher.test.ts` — unit tests
- `packages/daemon/src/service-registry.ts` — add manifest fetch + tool lifecycle hooks
- `packages/daemon/src/sessions/builtin-tool-registry.ts` — extend to support dynamic registration/deregistration

## Phase 4: HTTP Gateway

A reverse proxy that provides a single external entry point for all gateway-exposed services. Runs as an in-process HTTP listener.

- Implement gateway as an optional daemon subsystem (enabled via `gateway` config key)
- Path-based routing: `/{prefix}/{serviceId}/{path}` → service URL + path
- Auth enforcement: require valid Shoggoth token on all proxied requests (configurable per-service)
- CORS handling based on gateway config
- WebSocket upgrade support for `http+ws` services
- Register gateway shutdown drain (close listener, drain active connections)
- Health endpoint on gateway itself (`GET /{prefix}/_health`)

**Files:**

- `packages/shared/src/schema.ts` — add `gatewayConfigSchema` to top-level config
- `packages/daemon/src/gateway.ts` — HTTP gateway implementation
- `packages/daemon/src/gateway.test.ts` — integration tests with mock services
- `packages/daemon/src/index.ts` — conditional gateway startup, shutdown drain registration

## Phase 5: Service→Agent Callbacks

Enable services to push events back to agents (e.g., "user clicked a button in the Canvas UI").

- Service POSTs to a daemon-internal callback endpoint with a signed request
- Daemon validates the callback signature and injects a message into the target agent's turn queue
- Callback auth: service signs callback requests with its private key (the daemon already has the corresponding public key in the key store)
- Rate limiting on callbacks to prevent runaway services from flooding agent turns
- Callback endpoint is internal-only (not exposed through the gateway)

**Files:**

- `packages/daemon/src/service-callbacks.ts` — callback receiver and turn injection
- `packages/daemon/src/service-callbacks.test.ts` — tests
- `packages/daemon/src/gateway.ts` — add internal `/callbacks` route (bound to localhost only)

## Phase 6: Canvas Web Port (First Consumer)

Adapt Canvas Web to run as a Shoggoth-managed service. This validates the entire plugin spec end-to-end.

- Strip OpenClaw-specific auth (Ed25519 keypair, node registration) from Canvas Web
- Add Shoggoth token validation middleware using the public key provided during `shoggoth service register canvas-web`
- Expose `/health` and `/manifest` endpoints per service contract
- Manifest declares Canvas-specific tools: `canvas.push`, `canvas.show`, `canvas.reset`, etc.
- Configure as a `processes[]` entry with `service` block
- Verify end-to-end: agent calls `canvas.push` → daemon dispatches to Canvas → Canvas renders → browser displays

**Files:**

- Canvas Web repo (adapted fork or new package under `packages/canvas-web/`)
- Shoggoth config example in documentation
- Integration test: mock agent session → tool call → Canvas response
