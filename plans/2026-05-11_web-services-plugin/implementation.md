# Implementation

## Phase 1: Service Declaration & Registry

Extend the config schema to support both managed and external service declarations, and build the runtime registry that tracks healthy services. No external-facing changes yet — this is the foundation.

- Add `serviceDeclarationSchema` to `@shoggoth/shared` as an optional field on `processDeclarationSchema`
- Add `externalServiceDeclarationSchema` and top-level `services[]` config key
- Create `ServiceRegistry` class in the daemon (`src/service-registry.ts`)
- Wire registry to procman events for managed services: `process-started` → register, `process-stopped` / `process-failed` → deregister
- For external services, implement a health check polling loop (configurable interval) that registers/deregisters based on reachability
- Populate `ServiceEntry.url` from declaration's host + port + basePath
- Add config validation: detect port/ID conflicts across both managed and external service declarations at load time
- Both managed and external services produce the same `ServiceEntry` in the registry — downstream consumers (tools, gateway) don't need to know the difference

**Files:**

- `packages/shared/src/schema.ts` — add `serviceDeclarationSchema`, `externalServiceDeclarationSchema`, extend `processDeclarationSchema`
- `packages/daemon/src/service-registry.ts` — new `ServiceRegistry` class with health polling for external services
- `packages/daemon/src/service-registry.test.ts` — unit tests
- `packages/daemon/src/index.ts` — instantiate registry, subscribe to procman events, start external health polling

## Phase 2: Auth — Per-Service Age Identities with Operator Approval

Implement the service registration and approval flow via the operator CLI. Each approved service gets a unique age X25519 identity. The daemon stores the recipient (public key) and encrypts tokens to it; the service holds the identity (private key) and decrypts tokens.

- Add `shoggoth service register <id>` CLI command — prompts operator for approval, generates age identity on confirmation
- Add `shoggoth service rotate-key <id>` CLI command — generates new identity, displays new private key for the service
- Add `shoggoth service list` and `shoggoth service revoke <id>` CLI commands
- Implement `ServiceKeyStore` — stores recipients (public keys) in the daemon's credential store, keyed by service ID
- Implement `TokenMinter` — age-encrypted base64url payloads with agent ID, scope, expiry (encrypted to the service's recipient)
- Implement `TokenValidator` — decrypt with age identity, check expiry, decode payload (for use in `@shoggoth/service-auth` helper package)
- Service receives its identity (private key) once at registration time (displayed by CLI or written to a path)
- Services declared in config with no approved identity are started by procman but cannot receive authenticated tool requests until approved
- Reuses the existing `age-encryption` library already used by the vault system

**Files:**

- `packages/daemon/src/service-key-store.ts` — identity generation, recipient storage, retrieval
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

## Phase 5: Scoped Control Plane Access for Services

Enable services to interact with Shoggoth beyond responding to tool calls. Services connect to the existing control plane and are authorized based on their operator-approved scope.

- Add service authentication to the control plane — services connect and prove identity with their key pair
- Implement scope enforcement — each control plane operation is checked against the service's approved `ops` list
- Service manifest declares requested operations in an `ops[]` field
- `shoggoth service register` and `shoggoth service approve` display and gate the requested scope
- Scope stored alongside the key pair in the credential store
- Rate limiting per-service to prevent abuse (configurable per operation or globally)
- Connection lifecycle: service connects at startup, daemon drops connection on service deregistration or revocation

**Files:**

- `packages/daemon/src/control-plane/service-auth.ts` — authenticate service connections, enforce scope
- `packages/daemon/src/control-plane/service-auth.test.ts` — tests for auth + scope enforcement
- `packages/daemon/src/service-key-store.ts` — extend to store approved ops alongside key pair
- `packages/cli/src/commands/service.ts` — update register/approve to handle scope display and confirmation

## Future: Canvas Web Port (First Consumer)

The Canvas Web port will be done as a separate project. It serves as the first real consumer of this plugin system and will validate the spec end-to-end (tool registration, control plane access, gateway routing). See the OpenClaw Canvas Web repo for context on what needs to be adapted.
