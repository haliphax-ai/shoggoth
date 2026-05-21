# Implementation

## Phase 1: Service Key Store

Implement the core key management layer. This is the foundation everything else builds on — no tokens can be minted without stored recipients.

- Create `ServiceKeyStore` class backed by a `service_keys` table in the state DB
- `generateIdentity(serviceId)` — use the `age-encryption` library to generate an X25519 key pair, store the recipient, return the identity
- `getRecipient(serviceId)` — look up stored recipient by service ID
- `getFingerprint(serviceId)` — return first 16 chars of recipient for display
- `rotateIdentity(serviceId)` — generate new pair, replace stored recipient, return new identity
- `deleteIdentity(serviceId)` — remove row from `service_keys`
- `hasIdentity(serviceId)` — existence check
- Add state DB migration for `service_keys` table
- Unit tests: generate, retrieve, rotate, delete, persistence, duplicate ID handling

**Files:**

- `packages/daemon/src/service-key-store.ts`
- `packages/daemon/test/service-key-store.test.ts`
- `packages/daemon/src/state-db.ts` (migration for `service_keys` table)

## Phase 2: Token Minter & Validator

Implement token minting (daemon-side) and validation (service-side). These are the runtime primitives used by the dispatcher.

- Create `TokenMinter` class that takes a `ServiceKeyStore` reference
- `mint(agentId, serviceId, sessionUrn?)` — build payload, encrypt with age to recipient, encode as base64url
- Token payload: `{ sub, scope, iat, exp, session }` with 5-minute expiry
- Create `TokenValidator` static class (no daemon dependencies)
- `validate(token, identityString)` — decode base64url, decrypt with age identity, parse JSON, check expiry
- Unit tests: mint produces valid base64url, round-trip mint→validate, expired token rejected, wrong identity rejected, malformed input rejected

**Files:**

- `packages/daemon/src/service-auth.ts`
- `packages/daemon/test/service-auth.test.ts`

## Phase 3: Wire Token Minting into Tool Dispatcher

Replace the placeholder token with real minted tokens. This is the critical integration point — after this phase, services receive cryptographically valid tokens.

- Inject `TokenMinter` into `ServiceToolDispatcher` constructor
- In `dispatch()`, call `tokenMinter.mint(ctx.agentId, serviceId, ctx.sessionUrn)` instead of using `placeholderToken`
- Graceful fallback: if the service has no stored recipient (not yet approved with key), log a warning and use the placeholder token (backward compat during rollout)
- Update `ServiceToolDispatcher` constructor call sites to pass `TokenMinter`
- Update existing dispatcher tests to account for async token minting
- Integration test: approved service with key → dispatch uses real token → service can validate

**Files:**

- `packages/daemon/src/service-tool-dispatcher.ts`
- `packages/daemon/test/service-tool-dispatcher.test.ts`
- `packages/daemon/src/service-refs.ts` (wire TokenMinter into DI)

## Phase 4: Key Provisioning on Approve/Rotate/Revoke

Wire key lifecycle into the existing CLI commands and add the provisioning delivery mechanism. After this phase, operators can approve services and keys are delivered automatically.

- Update `service.approve` control operation to call `keyStore.generateIdentity(serviceId)` and deliver the identity to the service via `POST {serviceUrl}/_shoggoth/identity`
- If the service is unreachable at approval time (external services), fall back to displaying the key in CLI output and queue retry on next health check recovery
- Add `service.rotate-key` control operation — generates new identity, delivers to service, invalidates old tokens
- Add `shoggoth service rotate-key <id>` CLI command
- Update `service.revoke` control operation to call `keyStore.deleteIdentity(serviceId)`
- Add `shoggoth service register <id>` CLI command — submits registration request without approval
- Update `service.list` and `service.request` responses to include key fingerprint
- Add `key_fingerprint` and `approved_ops` columns to `service_approvals` table (migration)
- Track provisioning state (`delivered` / `pending`) in the key store so the lifecycle manager knows to retry
- Unit tests for control operations with key generation and delivery
- Unit tests for fallback behavior when service is unreachable

**Files:**

- `packages/daemon/src/control/service-ops.ts`
- `packages/cli/src/run-service.ts`
- `packages/daemon/src/service-lifecycle.ts` (retry provisioning on health recovery)
- `packages/daemon/test/service-control-auth.test.ts`
- `packages/daemon/src/state-db.ts` (migration for approval table columns)

## Phase 5: Standalone `@shoggoth/service-auth` Package

Extract `TokenValidator` and the identity provisioning handler into a standalone package that service authors can import without depending on the full daemon.

- Create `packages/service-auth/` package with minimal dependencies (`age-encryption` only)
- Export `TokenValidator` class and `ServiceTokenPayload` interface
- Export `createAuthMiddleware(opts)` — convenience middleware for validating Bearer tokens
- Export `createIdentityHandler(opts)` — HTTP handler for `POST /_shoggoth/identity` that receives and stores the private key via a caller-provided callback
- Add README with usage examples
- Add to monorepo workspace config
- Unit tests (validation round-trip, identity handler acceptance/rejection)

**Files:**

- `packages/service-auth/package.json`
- `packages/service-auth/tsconfig.json`
- `packages/service-auth/src/index.ts`
- `packages/service-auth/src/validator.ts`
- `packages/service-auth/src/middleware.ts`
- `packages/service-auth/src/identity-handler.ts`
- `packages/service-auth/test/validator.test.ts`
- `packages/service-auth/test/identity-handler.test.ts`
- `packages/service-auth/README.md`

## Phase 6: Plugin Fingerprinting & Ops Declaration

Bring plugin services into the approval and scope enforcement model. After this phase, plugins must declare their ops and be approved before those ops are available at runtime.

- Compute a deterministic fingerprint for each plugin at load time from its sorted tool declarations and ops array
- Add `ops` field to the `ServiceRegisterCtx` plugin registration API — plugins declare what control plane operations they intend to use
- On plugin load, check the approval store:
  - No record → create `pending` record with fingerprint and declared ops, suspend tools/ops until approved
  - Approved + fingerprint matches → tools and ops active
  - Approved + fingerprint changed → enter `pending-reapproval`, suspend tools/ops
  - Revoked → log warning, no tools/ops
- Add scope enforcement on plugin `deps` access — when a plugin calls a daemon operation via `deps`, check it against the plugin's approved ops list
- Wrap `deps` in a scope-checking proxy that rejects undeclared operations
- Plugin services appear in `shoggoth service list` / `requests` / `approve` / `revoke` like any other tier (with tier label "plugin")
- Unit tests: fingerprint computation is deterministic, fingerprint changes on tool/ops change, ops enforcement rejects undeclared access
- Integration test: plugin loads → pending → approve → ops work → plugin updates → pending-reapproval → re-approve → ops restored

**Files:**

- `packages/plugins/src/service-plugin.ts` (add ops declaration, fingerprint computation)
- `packages/plugins/src/plugin-system.ts` (approval check on load, deps proxy)
- `packages/plugins/test/plugin-system.test.ts`
- `packages/daemon/src/service-lifecycle.ts` (plugin approval integration)

## Phase 7: Scoped Control Plane Access (All Tiers)

Enable managed/external services to connect to the control plane and perform operations within their approved scope. Plugin services already have scope enforcement via the `deps` proxy (Phase 6) — this phase adds the network authentication path for managed/external services.

- Add `ops[]` field to service manifest schema (managed/external declare ops in their manifest)
- Display requested ops during `shoggoth service approve` for operator review (all tiers)
- Store approved ops in `service_approvals` table
- Add service authentication to control plane connection handshake (managed/external only):
  - Service sends `{ kind: "service_token", serviceId, token }` as auth
  - Control plane validates token using `ServiceKeyStore`
  - On success, connection is tagged with service ID and approved scope
- Add scope enforcement middleware to control plane operation dispatch:
  - Before executing any operation, check `isAuthorized(serviceId, op)`
  - Return scope error if not authorized
- Add per-service rate limiting (configurable, default 60 ops/minute)
- Connection lifecycle: drop connection on service revocation or key rotation
- Unit tests for auth handshake, scope enforcement, rate limiting, connection drop
- Integration test: service connects → authenticates → performs allowed op → attempts disallowed op → rejected

**Files:**

- `packages/daemon/src/control/service-auth.ts`
- `packages/daemon/test/service-control-auth.test.ts`
- `packages/daemon/src/control/control-plane.ts` (add service auth path)
- `packages/shared/src/schema.ts` (manifest ops field)
- `packages/daemon/src/service-lifecycle.ts` (notify control plane on revoke/rotate)

## Phase 8: Service Consumer Integration (Demo)

Update the demo service to consume the auth system, serving as the reference implementation for service authors.

### service-demo (managed service — full auth validation)

The demo service is a standalone managed process and the primary example of a service that validates Shoggoth tokens. It demonstrates the complete auth flow.

- Add `@shoggoth/service-auth` as a dependency
- Implement `POST /_shoggoth/identity` endpoint using `createIdentityHandler()` — writes the received key to `/var/lib/shoggoth/daemon/demo_service_key` by default (configurable via `DEMO_SERVICE_KEY_PATH` env var)
- On startup, read the identity from that file path if it exists
- Add auth middleware that extracts and validates the Bearer token on `/api/*` routes
- Reject unauthenticated requests to tool endpoints with 401
- Leave `/health`, `/manifest`, and `/_shoggoth/identity` endpoints unauthenticated (called by the daemon before auth is established)
- Log the decoded token payload (agent ID, session) for observability
- Update the manifest to declare `ops: []` (no control plane access needed)
- Add example in README showing how to test with a manually minted token

**Files:**

- `packages/service-demo/src/server.ts` (add identity endpoint, auth middleware)
- `packages/service-demo/package.json` (add `@shoggoth/service-auth` dependency)
- `packages/service-demo/README.md` (document auth setup)
