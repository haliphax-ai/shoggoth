---
date: 2026-05-20
completed: never
---

# Service Authentication & Authorization

## Summary

Implement cryptographic authentication and authorization for managed/external services using age X25519 key pairs. Replaces the placeholder bearer token in the tool dispatcher with real per-request minted tokens and enables scoped control plane access for services.

## Motivation

The service plugin system currently uses a hardcoded `"shoggoth-placeholder"` token in the tool dispatcher. This means:

- Any process that can reach a managed/external service's port can impersonate Shoggoth
- Services cannot authenticate back to the control plane for privileged operations

The approval flow (approve/revoke via CLI + fingerprint tracking) is already in place, but it only gates tool registration — it doesn't provide runtime authentication. This plan closes that gap by giving each approved service a unique age identity, minting short-lived encrypted tokens per request, and enforcing token validation at the dispatcher layer.

## Design

### Key Architecture

Each approved managed/external service receives a unique age X25519 key pair:

- **Recipient (public key)** — stored by the daemon in the `ServiceKeyStore`, keyed by service ID
- **Identity (private key)** — displayed to the operator once at approval time; the service uses it to decrypt tokens

Plugin services are exempt — they run in-process and are inherently trusted.

### Token Flow (Tool Dispatch)

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

### Key Store

`ServiceKeyStore` manages age key material in the daemon's data directory:

- `generateIdentity(serviceId)` — creates a new X25519 key pair, stores the recipient, returns the identity (private key) for one-time display
- `getRecipient(serviceId)` — retrieves the stored public key for token minting
- `rotateIdentity(serviceId)` — generates a new key pair, replaces the stored recipient, returns new identity
- `deleteIdentity(serviceId)` — removes key material on revocation

Key material is stored in the state DB alongside approval records, encrypted at rest using the daemon's master key (same pattern as the credential vault).

### CLI Commands

- `shoggoth service register <id>` — submits a registration request (does not auto-approve)
- `shoggoth service approve <id>` — approves the request, generates age identity, displays private key once
- `shoggoth service rotate-key <id>` — generates new identity, displays new private key
- `shoggoth service revoke <id>` — revokes approval, deletes key material, deregisters tools

The existing `list`, `requests`, and `request` commands already work and need no changes beyond displaying key fingerprints.

### Scoped Control Plane Access

Managed/external services can connect to the control plane and perform operations within their approved scope:

- Service manifest declares `ops[]` — the operations it wants to perform (e.g., `session.send`, `kv.get`)
- Scope is displayed during `shoggoth service approve` for operator review
- At runtime, the control plane authenticates the service connection using its age identity
- Each operation is checked against the approved `ops[]` list
- Unauthorized operations return a scope error without executing

### Integration Points

- `ServiceToolDispatcher` — replace `placeholderToken` with `TokenMinter.mint()` call
- `ServiceLifecycleManager` — generate key pair on approval, delete on revocation
- `service-ops.ts` — wire key generation into approve/revoke control operations

## Testing Strategy

- Unit tests for `ServiceKeyStore` (generate, get, rotate, delete, persistence across restarts)
- Unit tests for `TokenMinter` (mint produces valid base64url, payload contains correct fields, expiry is set)
- Unit tests for `TokenValidator` (valid token decrypts, expired token rejected, wrong identity rejected, malformed token rejected)
- Unit tests for round-trip: mint with recipient → validate with identity
- Unit tests for scoped control plane access (valid scope → allowed, missing scope → rejected, revoked service → connection dropped)
- Integration test: approve service → key generated → tool dispatch uses real token → service validates successfully
- Integration test: rotate key → old tokens fail → new tokens succeed
- Integration test: revoke service → key deleted → dispatch fails → re-approve → new key works

## Considerations

- **One-time key display** — The service's private key (identity) is shown exactly once at approval time. If the operator loses it, they must `rotate-key`. This matches the security model of age (no key escrow).
- **Token expiry window** — 5 minutes is short enough to limit replay but long enough to tolerate clock skew between daemon and service. Configurable per-service if needed later.
- **Clock skew** — Services with significant clock drift will reject valid tokens. Document that NTP sync is expected. A future enhancement could add a `leeway` parameter to `TokenValidator`.
- **Performance** — Age encryption per tool call adds latency (~1-5ms). For high-throughput services, consider a token cache with TTL < expiry. Deferred to a future optimization if profiling shows it matters.
- **Backward compatibility** — Services that don't validate auth today will continue to work (they ignore the Authorization header). The placeholder token is replaced transparently.
- **Plugin services** — Exempt from all auth. They run in the daemon process and are trusted by definition. No key generation, no token minting.
- **`packages/service-auth` helper** — A standalone npm package containing only `TokenValidator` so service authors can validate tokens without depending on the full daemon. Minimal dependencies (just `age-encryption`).
- **Gateway auth is out of scope** — This plan covers backchannel (daemon → service) authentication and scoped control plane access only. Gateway auth enforcement for external clients (browsers, third-party callers) requires a user-facing auth layer (session cookies, OAuth, etc.) and will be tackled in a future plan.

## Migration

- The `service_approvals` table gains an optional `key_fingerprint` column for tracking which key pair is active
- Existing approved services (approved before this feature) will need re-approval to generate a key pair, or the operator can run `rotate-key` to generate one without revoking
- The `ServiceKeyStore` creates its own table (`service_keys`) in the state DB on first use
- No breaking changes to existing config

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- [PR #49: Web Services Plugin System](https://github.com/haliphax-ai/shoggoth/pull/49) — original design (Phase 3 and Phase 6)
- [External Service Support](../done/2026-05-20_external-service-support/README.md) — external service tier (prerequisite)
- [Managed Service Lifecycle](../done/2026-05-18_managed-service-lifecycle/README.md) — managed process tier (prerequisite)
- [Credential Vault](../done/2026-05-08_credential-vault/README.md) — age encryption patterns reused here
