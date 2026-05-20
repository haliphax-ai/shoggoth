# Implementation

## Phase 1: Health Check Polling Infrastructure

Build the `ExternalServiceHealthPoller` class that performs periodic TCP/HTTP health checks for declared external services and emits state transition events.

- Implement `TcpHealthChecker` — socket connection with configurable timeout
- Implement `HttpHealthChecker` — GET request with expected status code and timeout
- Implement `ExternalServiceHealthPoller` class with per-service polling intervals
- Track consecutive failure count per service; only emit "unhealthy" after reaching `unhealthyThreshold`
- Implement exponential backoff on repeated failures (double interval, cap at `maxBackoffMs`)
- Reset to configured interval on recovery
- Emit "healthy" event on first success or recovery from unhealthy state
- Emit "unhealthy" event when failure threshold is reached
- Implement `add()`, `remove()`, `update()`, `stopAll()`, `getState()` methods
- Handle DNS resolution failures and connection timeouts gracefully

**Files:**

- `packages/daemon/src/external-service-health-poller.ts` — poller class with TCP/HTTP check implementations
- `packages/daemon/test/external-service-health-poller.test.ts` — unit tests for both check types, state transitions, backoff, threshold behavior

## Phase 2: Lifecycle Manager Integration

Extend `ServiceLifecycleManager` to handle external service health events, triggering the same manifest fetch → approval check → tool registration flow used by managed services.

- Add `onExternalServiceHealthy()` method — registers service entry, fetches manifest, checks approval, conditionally registers tools
- Add `onExternalServiceUnhealthy()` method — deregisters tools, marks service unhealthy in registry
- Wire `ExternalServiceHealthPoller` events to lifecycle manager in daemon entrypoint
- Instantiate poller during daemon startup, iterate `config.services[]` and call `add()` for each
- Register poller shutdown in daemon drain sequence
- Reuse existing `ManifestFetcher` for external service manifest retrieval
- Reuse existing `ServiceApprovalStore` for approval state (same table, same fingerprinting)
- External services appear in `shoggoth service list` with tier "external" and appropriate status

**Files:**

- `packages/daemon/src/service-lifecycle.ts` — extend with external service event handlers
- `packages/daemon/src/index.ts` — instantiate poller, wire events, register shutdown
- `packages/daemon/test/service-lifecycle.test.ts` — add tests for external service lifecycle (healthy/unhealthy transitions, approval gating, manifest fetch failure)

## Phase 3: Config Validation & Hot Reload

Add config-time validation for external service declarations and support hot reload of the `services[]` block without daemon restart.

- Add `externalServiceDeclarationSchema` to `@shoggoth/shared` schema (if not already present from PR #49 merge)
- Add top-level `services` key to the config schema
- Validate at config load: no ID conflicts between external services and managed services
- Implement `reconcileExternalServices()` on lifecycle manager — diff current vs new declarations, add/remove/update pollers accordingly
- Wire config hot-reload event to `reconcileExternalServices()`
- On service removal via hot reload: stop poller, deregister tools, deregister from registry
- On service modification via hot reload: stop old poller, deregister, start new poller with updated config

**Files:**

- `packages/shared/src/schema.ts` — add/verify `externalServiceDeclarationSchema`, top-level `services` config key
- `packages/daemon/src/service-lifecycle.ts` — add `reconcileExternalServices()` method
- `packages/daemon/src/index.ts` — wire config reload to reconciliation
- `packages/shared/test/schema.test.ts` — validation tests for external service config
- `packages/daemon/test/service-lifecycle.test.ts` — hot reload reconciliation tests

## Phase 4: CLI Visibility & Integration Testing

Ensure external services are fully visible in CLI output and write end-to-end integration tests covering the complete external service lifecycle.

- Update `shoggoth service list` to show external services with tier label and health state
- Update `shoggoth service requests` / `request <id>` to include external services pending approval
- Verify `shoggoth service approve` / `revoke` work correctly for external services
- Integration test: full lifecycle (service comes online → pending → approve → tools active → offline → tools removed → back online → tools restored)
- Integration test: manifest change triggers re-approval flow
- Integration test: revoked service stays revoked across daemon restarts
- Integration test: config hot reload adds/removes external services correctly
- Integration test: multiple external services with independent health states

**Files:**

- `packages/cli/src/commands/service.ts` — ensure external tier is displayed correctly (may already work if tier-agnostic)
- `packages/daemon/test/external-service-integration.test.ts` — end-to-end integration tests
