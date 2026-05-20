---
date: 2026-05-20
completed: never
---

# External Service Support

## Summary

Enable external processes (not managed by procman) to participate in the Shoggoth service ecosystem via health-check-driven registration, manifest-based tool discovery, operator approval gating, and HTTP proxy tool dispatch. External services are declared in the top-level `services[]` config and accessed exclusively over HTTP.

This is the final service tier from the web services plugin system (PR #49). It complements the plugin service tier (in-process hooks) and the managed service tier (procman lifecycle).

## Motivation

The managed service lifecycle feature (2026-05-18) wires procman-managed processes into the service registry. But many services run outside Shoggoth's control — in separate containers, on remote hosts, managed by systemd/Docker/k8s, or as long-running daemons that predate Shoggoth. These services need the same tool registration, health monitoring, and agent integration without requiring Shoggoth to own their lifecycle.

External services fill this gap: Shoggoth monitors their health via polling, fetches their manifest when reachable, and exposes their tools to agents — all without starting or stopping the process.

## Scope

### In scope

1. **Health check polling loop** — Periodic TCP or HTTP health checks for each declared external service, driving registration/deregistration in the service registry
2. **ExternalServiceHealthPoller** — Class that manages polling intervals, backoff on failure, and emits health state transitions
3. **Integration with ServiceLifecycleManager** — Health transitions trigger the same manifest fetch → approval check → tool registration flow used by managed services
4. **Config schema** — Top-level `services[]` array with `externalServiceDeclarationSchema` (already defined in shared schema from PR #49)
5. **Config validation** — Detect port/ID conflicts between external services and managed services at load time
6. **Operator approval** — External services use the same approval model as managed services (pending → approved → tools active). Reuses the `service_approvals` table and CLI commands.
7. **CLI visibility** — External services appear in `shoggoth service list` / `requests` / `request <id>` with tier label "external"
8. **Graceful startup** — External services that are unreachable at daemon boot are not errors; they transition to healthy/registered when they come online
9. **Hot reload** — Adding/removing/modifying external service declarations in config triggers poller reconfiguration without daemon restart

### Out of scope (separate features)

- Managed process lifecycle (already implemented — 2026-05-18)
- Plugin service registration (already works via hooks)
- Cryptographic auth (age key pairs, token minting/validation) — placeholder token used
- Gateway auth enforcement
- Scoped control plane access for services
- External service → daemon control plane connections

## Design

### Health Check Polling

Each external service declaration includes a `health` block specifying either TCP or HTTP checks:

- **TCP** — Attempt a socket connection to `host:port` (or `health.port` override). Success = healthy.
- **HTTP** — `GET health.url`, expect `health.expectedStatus` (default 200). Success = healthy.

The `ExternalServiceHealthPoller` runs an independent interval per service (configurable via `healthIntervalMs`, default 30s). On state transitions:

- **unhealthy → healthy**: Register service in registry, trigger manifest fetch + approval check
- **healthy → unhealthy**: Deregister tools, mark service unhealthy in registry
- **startup (unknown → unhealthy)**: Log info, no action (service not yet available)

Backoff: After 3 consecutive failures, the polling interval doubles (capped at 5 minutes). Resets to configured interval on recovery.

### Lifecycle Flow

```
Daemon starts, reads services[] config
  → ExternalServiceHealthPoller.start() for each external service
    → poll health endpoint at configured interval

Health poll succeeds (first time or recovery):
  → ExternalServiceHealthPoller emits "healthy" event
  → ServiceLifecycleManager.onExternalServiceHealthy(id, declaration)
    → build ServiceEntry (tier: "external", url from host:port:basePath)
    → registry.register(entry)
    → manifestFetcher.fetch(serviceUrl + manifestPath)
    → compute manifest fingerprint
    → check approval store (same logic as managed services):
      - pending: create request, no tools
      - approved + fingerprint match: register tools
      - approved + fingerprint changed: pending-reapproval, remove tools
      - revoked: log warning, no tools

Health poll fails (after being healthy):
  → ExternalServiceHealthPoller emits "unhealthy" event
  → ServiceLifecycleManager.onExternalServiceUnhealthy(id)
    → toolRegistry.deregisterServiceTools(id)
    → registry.markUnhealthy(id)

Daemon shutdown:
  → ExternalServiceHealthPoller.stopAll()
  → registry.deregister() for all external services
```

### Config Hot Reload

When config changes are detected:

- **New service added** — Start a new health poller for it
- **Service removed** — Stop its poller, deregister from registry, remove tools
- **Service modified** (host, port, health config) — Stop old poller, deregister, start new poller with updated config

### Integration with Existing Approval System

External services reuse the same approval infrastructure built for managed services:

- Same `service_approvals` state DB table
- Same CLI commands (`shoggoth service approve/revoke/requests/request`)
- Same manifest fingerprinting logic
- Same state machine (pending → approved → pending-reapproval → revoked)

The only difference is the tier label shown in CLI output ("external" vs "managed").

### Tool Dispatch

Identical to managed services — HTTP proxy dispatch through `ServiceToolDispatcher`:

1. Look up tool in `ServiceToolRegistry` → `{ kind: "http", serviceId, decl }`
2. Resolve URL from `ServiceRegistry.get(serviceId).url`
3. Build request per tool declaration (method, path, args as body/query)
4. Inject `Authorization: Bearer <token>` (placeholder until cryptographic auth feature)
5. Return response as `resultJson`

## Testing Strategy

- Unit tests for `ExternalServiceHealthPoller` (TCP check, HTTP check, state transitions, backoff, interval reset)
- Unit tests for health check edge cases (timeout, connection refused, unexpected status codes, DNS failure)
- Unit tests for `ServiceLifecycleManager` external service event handling (healthy/unhealthy transitions, approval gating)
- Unit tests for config hot reload (add/remove/modify external services)
- Unit tests for config validation (port/ID conflicts with managed services)
- Integration test: external service comes online → pending → approve → tools active → goes offline → tools removed → comes back → tools restored (fingerprint unchanged)
- Integration test: external service manifest changes → pending-reapproval → re-approve → tools updated
- Integration test: revoked external service → stays revoked across restarts

## Considerations

- **Network partitions** — A brief network blip shouldn't immediately deregister tools. Consider requiring N consecutive failures before marking unhealthy (configurable, default 3). This avoids tool flapping.
- **Startup ordering** — External services may start before or after Shoggoth. The poller handles both cases gracefully — it simply waits for the first successful health check.
- **Remote hosts** — Unlike managed services (always localhost), external services may be on remote hosts. Health checks must handle DNS resolution failures and higher latency.
- **Manifest caching** — Once fetched and approved, the manifest doesn't need to be re-fetched on every health recovery unless the service was fully deregistered. Cache the last-known manifest and only re-fetch if the service was marked unhealthy for longer than a configurable threshold.
- **Polling overhead** — With many external services, polling can generate significant traffic. The backoff mechanism helps, but operators should be aware of the tradeoff between `healthIntervalMs` and detection latency.
- **Auth placeholder** — Like managed services, external services receive a placeholder auth token until the cryptographic auth feature is implemented. Services that validate auth will reject requests until that feature lands.
- **Shared approval UX** — The CLI doesn't distinguish between approving a managed vs external service. The operator experience is identical, which is intentional.

## Migration

No existing data or configuration is affected. The top-level `services[]` config key is new and optional. Existing deployments without external services are unchanged.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- [PR #49: Web Services Plugin System](https://github.com/haliphax-ai/shoggoth/pull/49) — original design docs
- [Managed Service Lifecycle](../done/2026-05-18_managed-service-lifecycle/README.md) — managed process tier (prerequisite)
- [Procman plan](../done/2026-03-31_process-manager/README.md) — existing process manager design
