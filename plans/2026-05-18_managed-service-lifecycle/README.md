---
date: 2026-05-18
completed: never
---

# Managed Process Service Lifecycle

## Summary

Wire procman-managed processes that declare a `service` block into the service registry, enabling automatic service registration on process start, deregistration on stop/failure, manifest fetching for dynamic tool registration, health-driven tool lifecycle management, and operator approval gating.

This is a subset of the broader web services plugin system (PR #49). It focuses exclusively on the **managed process** tier — processes declared in `processes[]` with a `service` block that procman manages.

## Motivation

The service registry, tool registry, manifest fetcher, and HTTP tool dispatcher exist as standalone modules (designed in PR #49), but the daemon doesn't actually bridge procman lifecycle events to them. A managed process that starts up with a `service` block today is just a regular process — its service port, capabilities, and tools are invisible to agents.

This feature closes that gap: when procman starts a service-bearing process and it becomes healthy, the daemon registers it, fetches its manifest, and exposes its tools to agents — but only after the operator explicitly approves the service's advertised capabilities and tools. When the process stops or fails, tools are removed and the service is deregistered.

## Scope

### In scope

1. **Config schema extension** — Add optional `service` field to `processDeclarationSchema` (port, protocol, basePath, capabilities, expose, manifestPath, host)
2. **ServiceLifecycleManager** — Class that bridges procman events to the service registry and tool registry
3. **Procman event wiring** — Subscribe to `process-started`, `process-stopped`, `process-failed`, `health-changed` events in the daemon entrypoint
4. **Manifest fetching** — On service registration (process healthy), fetch `GET {serviceUrl}{manifestPath}` and register declared tools as HTTP proxy handlers
5. **Health-driven tool lifecycle** — When a service becomes unhealthy, deregister its tools; when it recovers, re-fetch manifest and re-register tools
6. **Config validation** — Detect port conflicts between managed services at config load time
7. **ServiceToolDispatcher wiring** — Connect the HTTP dispatch path so managed service tools actually proxy requests (with auth token injection placeholder)
8. **Operator approval flow** — Services require explicit operator approval before tools are exposed to agents. Manifest changes (new tools, changed capabilities, new ops) require re-approval.
9. **CLI commands** — `shoggoth service list`, `approve`, `revoke`, `requests`, `request <id>` for managing service trust
10. **Approval persistence** — Store approval state and approved manifest fingerprint in the state DB

### Out of scope (separate features)

- External service health polling and registration (separate tier)
- Plugin service registration (already works via hooks, implicitly trusted)
- Cryptographic auth (age key pairs, token minting/validation)
- Gateway auth enforcement
- Scoped control plane access for services
- Service demo plugin

## Design

### Approval Model

Services are untrusted by default. When a managed service first starts and serves its manifest, the daemon creates a **pending approval request**. The service is registered in the registry (so it appears in `service list`) but its tools are NOT exposed to agents until the operator approves.

Approval is tied to a **manifest fingerprint** — a hash of the service's declared tools, capabilities, and requested ops. If the service restarts with a changed manifest, the daemon detects the fingerprint mismatch and moves the service back to "pending re-approval" status. Tools are removed until the operator re-approves.

States:

- **pending** — service is running, manifest fetched, awaiting first-time approval
- **approved** — operator has approved; tools are active
- **pending-reapproval** — previously approved, but manifest changed; tools removed until re-approved
- **revoked** — operator explicitly revoked; tools removed, won't auto-approve even if manifest matches

### Procman Event Flow

```
procman emits "process-started" (processId, declaration)
  → ServiceLifecycleManager.onProcessStarted()
    → if declaration.service exists:
      → build ServiceEntry (tier: "managed", url from host:port)
      → registry.register(entry)
      → manifestFetcher.fetch(serviceUrl + manifestPath)
      → if fetch fails: mark unhealthy, log warning, stop (retry on next health-changed)
      → compute manifest fingerprint
      → check approval store:
        - if revoked: log warning, do NOT register tools
        - if no prior approval: create pending request, do NOT register tools
        - if approved AND fingerprint matches: register tools immediately
        - if approved AND fingerprint changed: mark pending-reapproval, remove tools

procman emits "process-stopped" or "process-failed" (processId)
  → ServiceLifecycleManager.onProcessStopped()
    → toolRegistry.deregisterServiceTools(id)
    → registry.deregister(id)

procman emits "health-changed" (processId, healthy)
  → ServiceLifecycleManager.onProcessHealthChanged()
    → if unhealthy: registry.markUnhealthy(id), toolRegistry.deregisterServiceTools(id)
    → if healthy: registry.markHealthy(id), re-check approval, conditionally re-register tools
```

### CLI Commands

| Command                         | Description                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `shoggoth service list`         | List all services (all tiers), showing status (pending/approved/revoked)        |
| `shoggoth service requests`     | List services with pending or pending-reapproval status                         |
| `shoggoth service request <id>` | Show full details of a pending request (tools, capabilities, ops, what changed) |
| `shoggoth service approve <id>` | Approve a pending/pending-reapproval service; stores fingerprint                |
| `shoggoth service revoke <id>`  | Revoke approval; immediately removes tools                                      |

### Tool Dispatch (HTTP Proxy)

When an agent calls a tool registered from a managed service manifest:

1. Look up the tool in `ServiceToolRegistry` → get `{ kind: "http", serviceId, decl }`
2. Resolve service URL from `ServiceRegistry.get(serviceId).url`
3. Build HTTP request: `decl.method` to `${url}${decl.path}` with args as JSON body
4. Inject `Authorization: Bearer <token>` header (placeholder — full cryptographic auth is a separate feature)
5. Return response body as `resultJson`

### Integration Points

- **`@shoggoth/shared` schema** — `processDeclarationSchema` gains optional `service` field
- **Daemon entrypoint** — Instantiates `ServiceLifecycleManager`, subscribes to procman events
- **Session tool executor** — Routes service tool calls through `ServiceToolRegistry.invokeTool()`
- **Session context finalizer** — Injects service tools into agent tool catalogs
- **State DB** — New `service_approvals` table for persisting approval state
- **CLI** — New `service` subcommand group

## Testing Strategy

- Unit tests for `ServiceRegistry` (register, deregister, health transitions, lookup)
- Unit tests for `ServiceToolRegistry` (both dispatch modes, deregistration)
- Unit tests for `ServiceToolDispatcher` (HTTP proxy with mocked fetch)
- Unit tests for `ManifestFetcher` (success, failure, invalid manifest)
- Unit tests for `ServiceLifecycleManager` (event handling, manifest fetch, tool lifecycle, approval gating)
- Unit tests for `ServiceApprovalStore` (CRUD, fingerprint comparison, state transitions)
- Unit tests for manifest fingerprinting (stable hash, detects changes)
- Unit tests for config schema validation (valid service blocks, port conflicts)
- Integration test for full lifecycle: procman start → pending → approve → tools active → manifest change → pending-reapproval → re-approve → tools active → stop → cleanup
- Integration test for revocation: approve → revoke → tools removed → restart → still revoked

## Considerations

- **Port conflicts** — Services declare their ports in config. The registry should detect conflicts at config validation time, not at runtime.
- **Manifest fetch timing** — The service may not be ready to serve its manifest immediately on process start. The lifecycle manager should wait for the health check to pass before fetching.
- **Manifest fetch failures** — If the manifest endpoint is unreachable or returns invalid data, the service is marked unhealthy and its tools are removed from agent contexts. A warning is logged. The service will be retried on the next health-changed event.
- **Tool name collisions** — If two services declare tools with the same name, the second registration should fail with a clear error. Builtin tools take precedence.
- **Hot reload** — If a service's config changes (port, basePath), the lifecycle manager should deregister and re-register. Ties into existing config hot-reload.
- **Auth placeholder** — The HTTP dispatcher injects a placeholder token header. Full age-encrypted auth is a separate feature; services that don't validate auth will work immediately.
- **Fingerprint stability** — The manifest fingerprint must be deterministic (sorted keys, stable serialization) so that identical manifests always produce the same hash regardless of JSON key ordering.
- **Plugin services skip approval** — Plugin services are trusted in-process code and don't go through the approval flow. This feature only gates managed (and eventually external) services.
- **Revocation is immediate** — When an operator revokes a service, its tools are removed from all agent contexts on the next tool catalog refresh. In-flight tool calls may still complete.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- [PR #49: Web Services Plugin System](https://github.com/haliphax-ai/shoggoth/pull/49) — original design docs
- [Procman plan](plans/done/2026-03-31_process-manager/README.md) — existing process manager design
