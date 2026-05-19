# Managed Service Lifecycle — Workflow Instructions

Project root: `/var/lib/shoggoth/workspaces/developer/projects/shoggoth`
Working directory for all commands: `/var/lib/shoggoth/workspaces/developer/projects/shoggoth`

## Global Rules

- Use `builtin-write` to create/modify files. NEVER use `node -e`, `cat`, `echo >`, or shell commands to write files.
- Use `builtin-read` to read files before modifying them.
- Use `builtin-exec` only for running tests, typecheck, and git commands.
- NEVER use `--no-verify` on git commit or push.
- RED tasks: stage files with `git add` but do NOT commit.
- GREEN tasks: run tests, run typecheck, then stage and commit.
- All `builtin-exec` commands should use `workdir` set to the project root above.

## Plan Reference

Read the full plan at: `plans/2026-05-18_managed-service-lifecycle/`

- `README.md` — overview, scope, design
- `spec.md` — type signatures, interfaces, code examples
- `implementation.md` — phased implementation steps with file lists

---

## Phase 1: Config Schema

### RED Task

1. Read `packages/shared/src/schema.ts` (find `processDeclarationSchema` around line 957).
2. Create test file `packages/daemon/test/service-schema.test.ts` with tests for:
   - Valid `service` block on a process declaration (port, protocol, basePath, capabilities, expose, manifestPath, host)
   - Invalid service blocks (missing port, invalid protocol, port out of range, etc.)
   - Port conflict validation: two processes declaring the same port+host should fail
   - Default values: basePath defaults to '/', expose defaults to 'direct', manifestPath defaults to '/manifest', host defaults to '127.0.0.1'
   - serviceManifestSchema validation (valid manifest, invalid manifest)
   - serviceToolDeclarationSchema validation (valid tool name regex, invalid names)
3. Add stub schemas to `packages/shared/src/schema.ts`:
   - `serviceDeclarationSchema` (from spec.md)
   - `serviceToolDeclarationSchema` (from spec.md)
   - `serviceManifestSchema` (from spec.md)
   - Add `service: serviceDeclarationSchema.optional()` to `processDeclarationSchema`
   - Add stub `validateServicePortConflicts()` that throws 'not implemented'
   - Export types: `ServiceDeclaration`, `ServiceManifest`, `ServiceToolDeclaration`
4. Update `packages/shared/src/index.ts` to export new schemas/types/function.
5. Run tests to confirm they fail: `npx vitest run packages/daemon/test/service-schema.test.ts`
6. `git add -A`

### GREEN Task

1. Read the test file and current schema stubs.
2. Implement schemas fully per spec.md.
3. Implement `validateServicePortConflicts(processes)` — checks for duplicate host+port among processes with `service` blocks.
4. Run tests: `npx vitest run packages/daemon/test/service-schema.test.ts` — all must pass.
5. Run typecheck: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/daemon/tsconfig.json`
6. `git add -A && git commit -m "feat(shared): add service declaration schema and port conflict validation"`

---

## Phase 2: Service Registry & Tool Registry

### RED Task

1. Read existing `packages/daemon/src/service-registry.ts` and `packages/daemon/src/service-tool-registry.ts`.
2. The `ServiceEntry` interface needs a new field: `tier: "plugin" | "managed" | "external"` (currently only "plugin").
3. Add fields to `ServiceEntry`: `manifest`, `approvalStatus`.
4. The `ServiceRegistry` needs: `setApprovalStatus(id, status)` method that emits "approval-changed".
5. The `ServiceToolRegistry` needs: `registerServiceTools(serviceId, manifest)` for HTTP proxy tools (new `RegisteredServiceTool` type with `kind: "http"`).
6. Create `packages/daemon/src/service-tool-dispatcher.ts` stub.
7. Create/update test files:
   - `packages/daemon/test/service-registry.test.ts` — add tests for new tier, approval status, manifest field
   - `packages/daemon/test/service-tool-registry.test.ts` — add tests for HTTP proxy tool registration
   - `packages/daemon/test/service-tool-dispatcher.test.ts` — tests for HTTP dispatch
8. Run tests to confirm failures, then `git add -A`.

### GREEN Task

1. Extend `ServiceEntry` with `tier: "plugin" | "managed" | "external"`, `manifest: ServiceManifest | null`, `approvalStatus`.
2. Add `setApprovalStatus()` to `ServiceRegistry`.
3. Add `registerServiceTools(serviceId, manifest)` to `ServiceToolRegistry` — creates HTTP proxy entries.
4. Implement `ServiceToolDispatcher` class:
   - `dispatch(serviceId, decl, args, ctx)` — builds HTTP request to service URL + decl.path
   - Injects `Authorization: Bearer shoggoth-placeholder` header
   - Handles non-2xx gracefully
5. Wire dispatcher into `ServiceToolRegistry.invokeTool()` for `kind: "http"` tools.
6. Run tests, typecheck, commit: `git commit -m "feat(daemon): extend service registry and tool registry for managed services"`

---

## Phase 3: Manifest Fetcher & Fingerprinting

### RED Task

1. Create `packages/daemon/src/manifest-fetcher.ts` stub.
2. Create `packages/daemon/src/manifest-fingerprint.ts` stub.
3. Create test files:
   - `packages/daemon/test/manifest-fetcher.test.ts` — tests with mocked HTTP (success, 404, invalid JSON, timeout, network error, retry on failure)
   - `packages/daemon/test/manifest-fingerprint.test.ts` — tests for deterministic hashing, change detection, key ordering independence
4. Run tests to confirm failures, then `git add -A`.

### GREEN Task

1. Implement `ManifestFetcher` class:
   - `fetchAndStore(serviceId, manifestPath?)` — fetches GET `{serviceUrl}{manifestPath}`
   - Validates against `serviceManifestSchema`
   - On success: stores manifest on registry entry, returns it
   - On failure: logs warning, returns null
   - 5s timeout, single retry with 1s delay on network error
2. Implement `computeManifestFingerprint(manifest, capabilities)`:
   - SHA-256 of canonical JSON (sorted tools by name, sorted ops, sorted capabilities)
   - Covers tools, ops, capabilities — NOT name/version/wsEndpoints
3. Run tests, typecheck, commit: `git commit -m "feat(daemon): add manifest fetcher and fingerprinting"`

---

## Phase 4: Approval Store & DB Migration

### RED Task

1. Create migration file `migrations/0016_service_approvals.sql` with the schema from spec.md.
2. Create `packages/daemon/src/service-approval-store.ts` stub.
3. Create test file `packages/daemon/test/service-approval-store.test.ts`:
   - Tests for get, upsert, approve, revoke, list, state transitions
   - Uses in-memory sqlite (see existing test patterns in `packages/daemon/test/helpers/`)
4. Run tests to confirm failures, then `git add -A`.

### GREEN Task

1. Implement `ServiceApprovalStore` class (sqlite-backed):
   - `get(serviceId)` — returns record or null
   - `upsert(serviceId, status, fingerprint?)` — create or update
   - `approve(serviceId, fingerprint)` — sets status "approved", stores fingerprint
   - `revoke(serviceId)` — sets status "revoked"
   - `list(status?)` — list all, optionally filtered
2. Run tests, typecheck, commit: `git commit -m "feat(daemon): add service approval store and DB migration"`

---

## Phase 5: ServiceLifecycleManager & Daemon Wiring

### RED Task

1. Read existing `packages/daemon/src/service-lifecycle.ts`.
2. Create test file `packages/daemon/test/service-lifecycle-manager.test.ts`:
   - Tests for `onProcessStarted` (with/without service block, manifest fetch success/failure, approval states)
   - Tests for `onProcessStopped` (deregisters tools and service)
   - Tests for `onProcessHealthChanged` (unhealthy removes tools, healthy re-checks approval)
   - Tests for `onServiceApproved` and `onServiceRevoked`
   - All dependencies mocked
3. Add `ServiceLifecycleManager` class stub to `packages/daemon/src/service-lifecycle.ts` (or a new file if cleaner).
4. Run tests to confirm failures, then `git add -A`.

### GREEN Task

1. Implement `ServiceLifecycleManager` class per spec.md:
   - `onProcessStarted(processId, declaration)` — full flow: register, fetch manifest, check approval, conditionally register tools
   - `onProcessStopped(processId)` — deregister tools and service
   - `onProcessHealthChanged(processId, healthy)` — health-driven tool lifecycle
   - `onServiceApproved(serviceId)` / `onServiceRevoked(serviceId)`
   - `shutdown()` — deregister all
2. Wire into daemon `packages/daemon/src/index.ts`:
   - Instantiate all components
   - Subscribe to procman events
   - Register shutdown drain
3. Run tests, typecheck, commit: `git commit -m "feat(daemon): implement ServiceLifecycleManager and wire to procman events"`

---

## Phase 6: CLI Commands

### RED Task

1. Read existing CLI structure in `packages/cli/src/` (e.g. `run-procman.ts` for patterns).
2. Create `packages/cli/src/run-service.ts` stub with command handlers.
3. Create `packages/daemon/src/control/service-ops.ts` stub for control plane ops.
4. Create test files:
   - `packages/cli/test/service-commands.test.ts` — tests for CLI output formatting
   - `packages/daemon/test/control/service-ops.test.ts` — tests for control plane ops
5. Run tests to confirm failures, then `git add -A`.

### GREEN Task

1. Implement CLI commands in `packages/cli/src/run-service.ts`:
   - `shoggoth service list` — list all services with tier, status, tool count, capabilities
   - `shoggoth service requests` — list pending/pending-reapproval services
   - `shoggoth service request <id>` — show full details
   - `shoggoth service approve <id>` — approve, store fingerprint
   - `shoggoth service revoke <id>` — revoke, remove tools
2. Implement control plane ops in `packages/daemon/src/control/service-ops.ts`.
3. Register the CLI subcommand in `packages/cli/src/cli.ts`.
4. Run tests, typecheck, commit: `git commit -m "feat(cli): add service management CLI commands"`

---

## Phase 7: Agent Integration

### RED Task

1. Read existing `packages/daemon/src/sessions/service-tool-finalizer.ts` and `packages/daemon/src/sessions/session-agent-turn.ts`.
2. Create/update test file `packages/daemon/test/service-integration.test.ts`:
   - End-to-end test: mock HTTP server, process declaration with service block, procman events
   - Verify tools don't appear until approved
   - Verify tools appear after approval
   - Verify tool invocation proxies HTTP request
   - Verify manifest change triggers re-approval
   - Verify process stop removes tools
3. Update `service-tool-finalizer.ts` to handle HTTP proxy tools (currently only handles direct tools).
4. Run tests to confirm failures, then `git add -A`.

### GREEN Task

1. Update `createServiceToolFinalizer()` to include HTTP proxy tools from approved services.
2. Update `session-agent-turn.ts` tool executor to route service tool calls through `serviceToolRegistry.invokeTool()`.
3. Set the `serviceToolRegistryRef.current` in daemon `index.ts` (if not already done in Phase 5).
4. Run the integration test, all other tests, typecheck.
5. Commit: `git commit -m "feat(daemon): integrate service tools into agent context and tool execution"`
