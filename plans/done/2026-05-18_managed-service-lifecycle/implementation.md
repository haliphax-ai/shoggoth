# Implementation

## Phase 1: Config Schema

Extend the shared config schema to support the `service` block on process declarations and validate port conflicts.

- Add `serviceDeclarationSchema` to `@shoggoth/shared`
- Add optional `service` field to `processDeclarationSchema`
- Add `serviceManifestSchema` and `serviceToolDeclarationSchema` (needed by manifest fetcher)
- Add `validateServicePortConflicts()` utility called during config loading
- Export new types: `ServiceDeclaration`, `ServiceManifest`, `ServiceToolDeclaration`
- Unit tests for schema validation (valid, invalid, port conflicts)

**Files:**

- `packages/shared/src/schema.ts` — add schemas, extend `processDeclarationSchema`
- `packages/shared/src/index.ts` — export new types/schemas
- `packages/daemon/test/service-schema.test.ts` — unit tests

## Phase 2: Service Registry & Tool Registry

Build the core runtime data structures that track services and their tools.

- Implement `ServiceRegistry` class extending `EventEmitter`
  - `register(entry)` — throws on duplicate ID
  - `deregister(id)` — emits "deregistered"
  - `markHealthy(id)` / `markUnhealthy(id)` — emits "health-changed"
  - `setApprovalStatus(id, status)` — emits "approval-changed"
  - `get(id)` / `findByCapability(cap)` / `list()`
- Implement `ServiceToolRegistry` class
  - `registerServiceTools(serviceId, manifest)` — registers HTTP proxy tools from manifest
  - `registerDirectTools(serviceId, tools)` — registers in-process handlers (for plugin tier compatibility)
  - `deregisterServiceTools(serviceId)` — removes all tools for a service
  - `get(toolName)` — returns `RegisteredServiceTool | undefined`
  - `listTools()` — returns all registered tools (for context finalizer)
  - `invokeTool(name, args, ctx)` — routes to direct handler or HTTP dispatcher
- Implement `ServiceToolDispatcher` class
  - `dispatch(serviceId, decl, args, ctx)` — builds HTTP request, sends to service URL, returns response
  - Placeholder auth: injects `Authorization: Bearer shoggoth-placeholder` header
  - Handles non-2xx responses gracefully (returns error JSON)
- Unit tests for all three classes

**Files:**

- `packages/daemon/src/service-registry.ts` — `ServiceRegistry` class
- `packages/daemon/src/service-tool-registry.ts` — `ServiceToolRegistry` class
- `packages/daemon/src/service-tool-dispatcher.ts` — `ServiceToolDispatcher` class
- `packages/daemon/test/service-registry.test.ts` — unit tests
- `packages/daemon/test/service-tool-registry.test.ts` — unit tests
- `packages/daemon/test/service-tool-dispatcher.test.ts` — unit tests

## Phase 3: Manifest Fetcher & Fingerprinting

Fetch and validate service manifests from running managed processes. Compute deterministic fingerprints for approval comparison.

- Implement `ManifestFetcher` class
  - `fetchAndStore(serviceId, manifestPath?)` — fetches `GET {serviceUrl}{manifestPath}`
  - Validates response against `serviceManifestSchema`
  - On success: stores manifest on the registry entry, returns it
  - On failure: logs warning, returns null; caller marks service unhealthy and removes tools
- Configurable timeout (default 5s) for manifest fetch
- Retry logic: single retry with 1s delay on network error (service may still be starting)
- Implement `computeManifestFingerprint(manifest, capabilities)` utility
  - SHA-256 hash of canonical JSON (sorted tools by name, sorted ops, sorted capabilities)
  - Covers tools, ops, capabilities — NOT name/version/wsEndpoints
  - Deterministic regardless of JSON key ordering
- Unit tests with mocked HTTP responses (success, 404, invalid JSON, timeout, network error)
- Unit tests for fingerprint stability and change detection

**Files:**

- `packages/daemon/src/manifest-fetcher.ts` — `ManifestFetcher` class
- `packages/daemon/src/manifest-fingerprint.ts` — `computeManifestFingerprint()` utility
- `packages/daemon/test/manifest-fetcher.test.ts` — unit tests
- `packages/daemon/test/manifest-fingerprint.test.ts` — unit tests

## Phase 4: Approval Store & DB Migration

Persist service approval state in the state DB. Provide CRUD operations for the approval lifecycle.

- Add DB migration creating `service_approvals` table
  - `service_id TEXT PRIMARY KEY`
  - `status TEXT NOT NULL DEFAULT 'pending'`
  - `approved_fingerprint TEXT` (null until first approval)
  - `created_at TEXT NOT NULL`
  - `updated_at TEXT NOT NULL`
- Implement `ServiceApprovalStore` class (sqlite-backed)
  - `get(serviceId)` — returns record or null
  - `upsert(serviceId, status, fingerprint?)` — create or update
  - `approve(serviceId, fingerprint)` — sets status to "approved", stores fingerprint
  - `revoke(serviceId)` — sets status to "revoked", clears fingerprint
  - `list(status?)` — list all, optionally filtered
- Unit tests for all CRUD operations and state transitions

**Files:**

- `packages/daemon/src/db/migrations/NNNN_service_approvals.ts` — migration
- `packages/daemon/src/service-approval-store.ts` — `ServiceApprovalStore` class
- `packages/daemon/test/service-approval-store.test.ts` — unit tests

## Phase 5: ServiceLifecycleManager & Daemon Wiring

Bridge procman lifecycle events to the service registry, tool registry, and approval store. Wire everything together in the daemon entrypoint.

- Implement `ServiceLifecycleManager` class
  - Constructor takes `{ registry, manifestFetcher, toolRegistry, approvalStore, logger }`
  - `onProcessStarted(processId, declaration)`:
    - Skip if no `declaration.service`
    - Build `ServiceEntry` with tier "managed", URL from host:port
    - `registry.register(entry)`
    - `manifestFetcher.fetchAndStore(processId, manifestPath)`
    - If manifest fetch fails: mark service unhealthy, log warning, return (no tools, no approval request)
    - Compute fingerprint via `computeManifestFingerprint()`
    - Check approval store:
      - No record → create "pending", do NOT register tools
      - Revoked → log warning, do NOT register tools
      - Approved + fingerprint matches → register tools
      - Approved + fingerprint changed → mark "pending-reapproval", deregister tools
  - `onProcessStopped(processId)`:
    - `toolRegistry.deregisterServiceTools(processId)`
    - `registry.deregister(processId)`
  - `onProcessHealthChanged(processId, healthy)`:
    - If unhealthy: `registry.markUnhealthy(id)`, `toolRegistry.deregisterServiceTools(id)`
    - If healthy: `registry.markHealthy(id)`, re-check approval, conditionally re-register tools
  - `onServiceApproved(serviceId)`:
    - If service is currently registered and healthy, register its tools
    - Update registry approval status
  - `onServiceRevoked(serviceId)`:
    - `toolRegistry.deregisterServiceTools(serviceId)`
    - Update registry approval status
  - `shutdown()`: deregister all tracked services
- Wire into daemon `index.ts`:
  - Instantiate `ManifestFetcher`, `ServiceToolDispatcher`, `ServiceToolRegistry`, `ServiceApprovalStore`, `ServiceLifecycleManager`
  - Subscribe to procman events: `process-started`, `process-stopped`, `process-failed`, `health-changed`
  - Map process declarations by ID for lookup
  - Register shutdown drain
- Unit tests for `ServiceLifecycleManager` with mocked dependencies (all approval paths)

**Files:**

- `packages/daemon/src/service-lifecycle.ts` — `ServiceLifecycleManager` class + factory helpers
- `packages/daemon/src/index.ts` — wire lifecycle manager to procman events
- `packages/daemon/test/service-lifecycle.test.ts` — unit tests

## Phase 6: CLI Commands

Add `shoggoth service` subcommand group for operator management of service approvals.

- `shoggoth service list` — list all services with tier, status, tool count, capabilities
  - Reads from approval store + live registry (for running services)
  - Shows plugin services as "approved (plugin)" — they skip the flow
- `shoggoth service requests` — list services with pending/pending-reapproval status
  - Shows service ID, tier, status, tool count, requested ops
- `shoggoth service request <id>` — show full details of a pending request
  - Tools with name, method, path, description
  - Capabilities, requested ops
  - If pending-reapproval: show diff (added/removed tools, changed ops)
- `shoggoth service approve <id>` — approve a pending service
  - Stores fingerprint in approval store
  - Calls `serviceLifecycle.onServiceApproved(id)` via control plane op
  - Confirms with tool/op count
- `shoggoth service revoke <id>` — revoke an approved service
  - Updates approval store
  - Calls `serviceLifecycle.onServiceRevoked(id)` via control plane op
  - Confirms revocation
- Add control plane ops: `service.approve`, `service.revoke`, `service.list`, `service.requests`, `service.request`
- Unit tests for CLI output formatting
- Integration tests for approve/revoke round-trip

**Files:**

- `packages/cli/src/commands/service.ts` — CLI command implementations
- `packages/daemon/src/control/service-ops.ts` — control plane operation handlers
- `packages/cli/test/service-commands.test.ts` — unit tests
- `packages/daemon/test/service-ops.test.ts` — integration tests

## Phase 7: Agent Integration

Make service tools visible to agents and route tool calls through the service tool registry.

- Implement `serviceToolFinalizer` context finalizer
  - Reads all tools from `ServiceToolRegistry.listTools()`
  - Only includes tools from services with `approvalStatus === "approved"`
  - Converts each to a tool descriptor (name, description, parameters schema)
  - Appends to the session's aggregated tool list
  - Registered via `registerContextFinalizer()` in daemon entrypoint
- Create `service-tool-registry-ref.ts` singleton ref
  - Allows the finalizer and tool executor to access the registry without circular imports
- Extend session tool executor (`session-agent-turn.ts`)
  - After checking builtin tools and MCP tools, check `serviceToolRegistryRef.current`
  - If tool is found there, invoke via `serviceToolRegistry.invokeTool()`
  - Return result to agent
- End-to-end integration test:
  - Start a mock HTTP server (simulating a managed service with manifest)
  - Configure a process declaration with a `service` block
  - Simulate procman "process-started" event
  - Verify tools do NOT appear (pending approval)
  - Approve via approval store
  - Verify tools now appear in agent context
  - Call a tool, verify HTTP request reaches mock server
  - Simulate manifest change, verify tools removed (pending-reapproval)
  - Re-approve, verify tools restored
  - Simulate "process-stopped", verify tools removed

**Files:**

- `packages/daemon/src/sessions/service-tool-finalizer.ts` — context finalizer
- `packages/daemon/src/sessions/service-tool-registry-ref.ts` — singleton ref
- `packages/daemon/src/sessions/session-agent-turn.ts` — extend tool executor routing
- `packages/daemon/src/sessions/session-mcp-runtime.ts` — register finalizer
- `packages/daemon/src/index.ts` — set singleton ref, register finalizer
- `packages/daemon/test/service-integration.test.ts` — end-to-end test
