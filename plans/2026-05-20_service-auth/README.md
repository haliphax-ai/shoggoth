---
date: 2026-05-20
completed: never
---

# Service Authentication & Authorization

## Summary

Implement cryptographic authentication and authorization for managed/external services using age X25519 key pairs. Replaces the placeholder bearer token in the tool dispatcher with real per-request minted tokens and enables scoped control plane access for all service tiers. Plugin services are fingerprinted and scope-checked like managed/external services, but exempt from token auth on direct tool calls.

## Motivation

The service plugin system currently uses a hardcoded `"shoggoth-placeholder"` token in the tool dispatcher. This means:

- Any process that can reach a managed/external service's port can impersonate Shoggoth
- Services cannot authenticate back to the control plane for privileged operations
- Plugin services have unchecked access to daemon internals via `deps` with no scope enforcement

The approval flow (approve/revoke via CLI + fingerprint tracking) is already in place, but it only gates tool registration — it doesn't provide runtime authentication or authorization. This plan closes that gap by giving each approved managed/external service a unique age identity, minting short-lived encrypted tokens per request, and enforcing scope-checked control plane access across all tiers.

## Design

### Trust Model

All three service tiers participate in fingerprinting and ops authorization, but with different levels of trust:

|                            | Plugin         | Managed | External |
| -------------------------- | -------------- | ------- | -------- |
| Fingerprinted              | ✓              | ✓       | ✓        |
| Declares ops               | ✓              | ✓       | ✓        |
| Ops enforced               | ✓              | ✓       | ✓        |
| Token auth (tool dispatch) | ✗ (in-process) | ✓       | ✓        |
| Key provisioning           | ✗              | ✓       | ✓        |
| Approval required          | ✓              | ✓       | ✓        |

Plugin services are more trusted in that they don't need cryptographic proof on each tool call (they execute in-process, so impersonation isn't possible). But they are not unconditionally trusted — they require operator approval before activation (tools and ops remain suspended until approved), must declare what operations they intend to perform, and those declarations are enforced at runtime.

### Key Architecture

Each approved managed/external service receives a unique age X25519 key pair:

- **Recipient (public key)** — stored by the daemon in the `ServiceKeyStore`, keyed by service ID
- **Identity (private key)** — delivered to the service at approval time; the service uses it to decrypt tokens

Plugin services do not receive key pairs — their tool calls are direct function invocations within the daemon process.

### Token Flow (Tool Dispatch — Managed/External Only)

```
Agent calls service tool
  → ServiceToolDispatcher.dispatch()
    → TokenMinter.mint(agentId, serviceId, sessionUrn)
      → Build JSON payload: { sub, scope, iat, exp, session }
      → Encrypt payload with age to the service's recipient
      → Encode as base64url
    → Inject as Authorization: Bearer <token>
    → HTTP request to service

Service receives request
  → Extract Bearer token from Authorization header
  → TokenValidator.validate(token, identityString)
    → Decode base64url → age ciphertext
    → Decrypt with service's identity (private key)
    → Parse JSON payload
    → Check exp > now
    → Return payload (sub, scope, session) or null
  → Service knows which agent/session is calling and can enforce its own logic
```

### Fingerprinting

All service tiers are fingerprinted to detect changes that require re-approval:

- **Plugin services** — fingerprint is computed from the plugin's declared tools and ops at load time. If the plugin is updated and its fingerprint changes, it enters `pending-reapproval` and its tools/ops are suspended until the operator re-approves.
- **Managed/external services** — fingerprint is computed from the fetched manifest (existing behavior).

### Key Store

`ServiceKeyStore` manages age key material in the daemon's data directory:

- `generateIdentity(serviceId)` — creates a new X25519 key pair, stores the recipient, returns the identity (private key) for provisioning
- `getRecipient(serviceId)` — retrieves the stored public key for token minting
- `rotateIdentity(serviceId)` — generates a new key pair, replaces the stored recipient, returns new identity
- `deleteIdentity(serviceId)` — removes key material on revocation

Key material (recipients only) is stored in the state DB alongside approval records. The daemon does not persist private keys — they are generated, delivered to the service, and discarded.

### Key Provisioning (Managed/External Only)

When a service is approved (or its key is rotated), the daemon delivers the private key directly to the service over its existing HTTP channel:

1. Daemon generates the age key pair
2. Daemon calls `POST {serviceUrl}/_shoggoth/identity` with the private key in the request body
3. Service receives the key and stores it however it sees fit (memory, file, env, secrets manager)
4. Daemon stores only the recipient (public key)

The provisioning endpoint is part of the service contract — services that want to participate in authenticated dispatch must implement `POST /_shoggoth/identity`. The `@shoggoth/service-auth` package provides a handler for this.

For external services that may not be reachable at approval time, the CLI falls back to displaying the key for manual delivery. The daemon retries provisioning on the next health check recovery if the initial delivery failed.

### CLI Commands

- `shoggoth service register <id>` — submits a registration request (does not auto-approve)
- `shoggoth service approve <id>` — approves the request; for managed/external, generates age identity and delivers key to service
- `shoggoth service rotate-key <id>` — generates new identity, delivers new key to service (managed/external only)
- `shoggoth service revoke <id>` — revokes approval, deletes key material, deregisters tools

The existing `list`, `requests`, and `request` commands already work and need no changes beyond displaying key fingerprints and approved ops.

### Scoped Control Plane Access (All Tiers)

All services — including plugins — must declare their intended operations and have them enforced:

- Service manifest (or plugin registration) declares `ops[]` — the operations it wants to perform (e.g., `session.send`, `kv.get`)
- Scope is displayed during `shoggoth service approve` for operator review
- At runtime, every control plane operation is checked against the service's approved `ops[]` list
- Unauthorized operations return a scope error without executing

For managed/external services, the control plane authenticates the connection using the service's age identity. For plugin services, the caller is already identified (in-process), so only scope enforcement applies — no cryptographic handshake needed.

### Integration Points

- `ServiceToolDispatcher` — replace `placeholderToken` with `TokenMinter.mint()` call (managed/external only)
- `ServiceLifecycleManager` — generate key pair on approval, delete on revocation (managed/external only)
- `service-ops.ts` — wire key generation into approve/revoke control operations
- Plugin system — compute fingerprint at load time, enforce ops on `deps` access

## Testing Strategy

- Unit tests for `ServiceKeyStore` (generate, get, rotate, delete, persistence across restarts)
- Unit tests for `TokenMinter` (mint produces valid base64url, payload contains correct fields, expiry is set)
- Unit tests for `TokenValidator` (valid token decrypts, expired token rejected, wrong identity rejected, malformed token rejected)
- Unit tests for round-trip: mint with recipient → validate with identity
- Unit tests for scoped control plane access (valid scope → allowed, missing scope → rejected, revoked service → connection dropped)
- Unit tests for plugin fingerprinting (fingerprint changes → pending-reapproval, stable fingerprint → no change)
- Unit tests for plugin ops enforcement (allowed op → succeeds, disallowed op → rejected)
- Integration test: approve service → key generated → tool dispatch uses real token → service validates successfully
- Integration test: rotate key → old tokens fail → new tokens succeed
- Integration test: revoke service → key deleted → dispatch fails → re-approve → new key works
- Integration test: plugin declares ops → approved → calls allowed op → succeeds → calls undeclared op → rejected

## Considerations

- **Key provisioning endpoint** — Services must implement `POST /_shoggoth/identity` to receive their private key. If the service is unreachable at approval time (external services), the CLI falls back to displaying the key. The daemon never persists private keys — if a service loses its key, the operator runs `rotate-key` to generate and deliver a new one.
- **Token expiry window** — 5 minutes is short enough to limit replay but long enough to tolerate clock skew between daemon and service. Configurable per-service if needed later.
- **Clock skew** — Services with significant clock drift will reject valid tokens. Document that NTP sync is expected. A future enhancement could add a `leeway` parameter to `TokenValidator`.
- **Performance** — Age encryption per tool call adds latency (~1-5ms). For high-throughput services, consider a token cache with TTL < expiry. Deferred to a future optimization if profiling shows it matters.
- **Backward compatibility** — Services that don't validate auth today will continue to work (they ignore the Authorization header). The placeholder token is replaced transparently.
- **Plugin trust boundary** — Plugins run in-process so they can't be impersonated, but they can still exceed their declared scope. Ops enforcement on plugins prevents a compromised or buggy plugin from accessing operations it never declared. This is defense-in-depth, not a hard security boundary.
- **Plugin fingerprint stability** — Plugin fingerprints must be deterministic across daemon restarts. The fingerprint is computed from the sorted, serialized tool declarations and ops array — not from file contents or load order.
- **`packages/service-auth` helper** — A standalone npm package containing only `TokenValidator` so service authors can validate tokens without depending on the full daemon. Minimal dependencies (just `age-encryption`).
- **Gateway auth is out of scope** — This plan covers backchannel (daemon → service) authentication and scoped control plane access only. Gateway auth enforcement for external clients (browsers, third-party callers) requires a user-facing auth layer (session cookies, OAuth, etc.) and will be tackled in a future plan.

## Migration

- The `service_approvals` table gains an optional `key_fingerprint` column for tracking which key pair is active
- The `service_approvals` table gains an `approved_ops` column (JSON array)
- Existing approved services (approved before this feature) will need re-approval to generate a key pair (managed/external) or to record their ops (all tiers)
- Existing plugin services currently activate without approval. After this feature lands, they will enter `pending` on first load and remain inactive until the operator approves them via `shoggoth service approve`
- The `ServiceKeyStore` creates its own table (`service_keys`) in the state DB on first use
- No breaking changes to existing config

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- [PR #49: Web Services Plugin System](https://github.com/haliphax-ai/shoggoth/pull/49) — original design (Phase 3 and Phase 6)
- [External Service Support](../done/2026-05-20_external-service-support/README.md) — external service tier (prerequisite)
- [Managed Service Lifecycle](../done/2026-05-18_managed-service-lifecycle/README.md) — managed process tier (prerequisite)
- [Credential Vault](../done/2026-05-08_credential-vault/README.md) — age encryption patterns reused here
