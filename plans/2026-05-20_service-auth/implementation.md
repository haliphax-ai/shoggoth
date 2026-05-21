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

## Phase 6: Scoped Control Plane Access

Enable managed/external services to connect to the control plane and perform operations within their approved scope. This is the most complex phase — it adds a new authentication path to the control plane.

- Add `ops[]` field to service manifest schema
- Display requested ops during `shoggoth service approve` for operator review
- Store approved ops in `service_approvals` table
- Add service authentication to control plane connection handshake:
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

## Phase 7: Service Consumer Integration (Demo & Canvas)

Update the existing service packages to consume the auth system, serving as reference implementations for service authors.

### service-demo (managed service — full auth validation)

The demo service is a standalone managed process and the primary example of a service that validates Shoggoth tokens. It demonstrates the complete auth flow.

- Add `@shoggoth/service-auth` as a dependency
- Add auth middleware that extracts and validates the Bearer token on `/api/*` routes
- Read the service identity from `SERVICE_IDENTITY` environment variable (injected by procman or set manually)
- Reject unauthenticated requests to tool endpoints with 401
- Leave `/health` and `/manifest` endpoints unauthenticated (called by the daemon before auth is established)
- Log the decoded token payload (agent ID, session) for observability
- Update the manifest to declare `ops: []` (no control plane access needed)
- Add example in README showing how to test with a manually minted token

**Files:**

- `packages/service-demo/src/server.ts` (add auth middleware)
- `packages/service-demo/package.json` (add `@shoggoth/service-auth` dependency)
- `packages/service-demo/README.md` (document auth setup)

### service-canvas (plugin service — no auth changes)

The canvas service is a plugin (in-process, trusted). Plugin services are exempt from auth — they don't receive tokens on direct tool calls and don't need to validate anything. No code changes required for the auth layer itself.

- Verify canvas continues to work unchanged with the new dispatcher (plugin tools bypass `ServiceToolDispatcher` entirely)
- Document in canvas README that plugin services are inherently trusted and don't participate in the token auth flow
- If canvas ever moves to a managed/external service tier in the future, it would need to add `@shoggoth/service-auth` at that point

**Files:**

- `packages/service-canvas/README.md` (document auth exemption for plugin tier)
