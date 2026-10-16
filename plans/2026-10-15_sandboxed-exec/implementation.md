# Implementation

## Phase 1: SRT/Docker Feasibility Spike

Resolve the main blocker before broad code integration: prove the pinned SRT backend can run inside the production-like Docker image, under the agent UID/GID and current capability model, with per-invocation workspace read/write restrictions and no network. Record the minimal filesystem/runtime allowances and actual host/kernel/container prerequisites. Pin the candidate package version; fail this phase rather than enabling weaker isolation or silently broadening permissions if the host cannot enforce the desired boundary.

- Inspect the exact tagged SRT version's config schema, Linux bubblewrap arguments, settings path resolution and library/CLI entrypoints.
- Build an isolated proof using a fresh temporary workspace and marker files outside it; test reads/writes via shell, `cat`, Python, symlinks, and network.
- Test under the actual `agent` UID/GID, production container user namespace/capabilities, and target host kernel.
- Measure startup/cleanup behavior and whether concurrent invocations can have independent immutable policy.
- Document the selected adapter (library vs CLI), list of allowed roots, prerequisites, and failure behavior in the plan before integrating.

**Files:**

- `plans/2026-10-15_sandboxed-exec/spec.md` (update with verified policy and invocation contract)
- New isolated prototype/test fixture under `packages/os-exec/test/` or `test/` (remove or promote deliberately after spike)
- `Dockerfile`, `docker-compose.yml`, or CI container definition only if evidence shows a narrowly scoped change is required

## Phase 2: Policy Builder and Sandboxed Runner

Add the new internal policy builder and process runner without switching existing exec call sites. Keep modules small and independently testable. The runner must fail closed and clean all per-run settings/resources on every success, failure, timeout, and cancellation path.

- Add the pinned `@anthropic-ai/sandbox-runtime` dependency to the appropriate workspace package and update the lockfile.
- Implement canonical root validation and trusted policy construction; do not accept allowed roots/network policy from tool args or env.
- Implement per-invocation SRT startup via the verified adapter; support argument-safe Bash invocation and policy isolation under concurrent calls.
- Preserve agent uid/gid, sanitized environment, stdin, cwd, output capture, process groups, timeout handling and signal semantics.
- Add unit tests for policy mapping, quoting, failures, cleanup, timeout/result mapping and concurrent independent policy.
- Add OS-backed security tests proving workspace read/write succeeds and forbidden access fails through diverse utilities/interpreters.

**Files:**

- `packages/os-exec/package.json`
- `package-lock.json`
- New `packages/os-exec/src/exec-sandbox-policy.ts`
- New `packages/os-exec/src/sandboxed-subprocess.ts`
- New policy and runner tests under `packages/os-exec/test/`
- `packages/os-exec/src/index.ts` (export only if needed internally)

## Phase 3: Route All Foreground Exec Through Sandbox

Switch both basic and extended foreground execution to the sandbox runner. Retain Shoggoth path checks, output shaping, file output caps, and user-facing builtin-exec results. Verify shell/argv semantics and do not broaden policy to accommodate unverified command expectations.

- Replace the direct `runAsUser` call for basic `toolExec` with `runSandboxedExec`.
- Replace the extended foreground Bash spawn path with the same runner.
- Ensure workdir and output-file resolution remains confined to the canonical workspace before execution.
- Ensure custom env cannot override sandbox controls, runtime settings paths, or trusted wrapper environment.
- Update user-facing docs with sandbox behavior, denied-access errors, network defaults, deployment prerequisites, and troubleshooting.
- Test success, nonzero exit, split streams, output truncation/file output, stdin, custom cwd/env, timeout and invalid settings.

**Files:**

- `packages/os-exec/src/tools.ts`
- `packages/os-exec/test/tools-exec.test.ts` and relevant extended-exec tests
- `packages/daemon/src/sessions/builtin-handlers/exec-handler.ts` only if result/error mapping requires adjustment
- `packages/daemon/test/builtin-handlers/exec-handler.test.ts` only if mapping changes
- `docs/tools/builtin-exec.md`

## Phase 4: Background, Yield, Poll, and Process-Tree Integration

Ensure procman background and yield paths launch the SRT-wrapped command under an identical per-invocation policy and maintain process ownership/termination through the wrapper/child tree.

- Adapt the procman `ProcessSpec` or managed-process launch seam so wrapper, sandbox child, and descendants are tracked/terminated as one invocation.
- Avoid shared mutable per-invocation settings and ensure settings remain valid for the full background lifetime.
- Clean policy files/resources when the process exits, is stopped, times out, errors during startup, or the daemon shuts down.
- Verify `poll` output/status and timeout behavior do not regress.
- Add integration tests for background/yield completion, long-lived child cleanup and denial of outside access after yield.

**Files:**

- `packages/os-exec/src/tools.ts`
- `packages/os-exec/src/subprocess.ts` or the verified procman integration seam
- `packages/procman/src/managed-process.ts` and focused tests only if process-tree support requires changes
- `packages/os-exec/test/tools-exec-extended.test.ts`
- `packages/os-exec/test/poll.test.ts` (or current poll suite)
- `packages/daemon/test/sessions/` or builtin-handler tests only where integration behavior changes

## Phase 5: Deployment Hardening and Cross-Cutting Regression

Ship only after the real sandbox path is validated in the supported deployment environment. Keep existing HITL, OS identity separation, and managed-tool guards; do not deprecate curated tools in this phase.

- Add required SRT runtime assets and documented platform prerequisites to the production image/deployment configuration, if not already supplied by the package.
- Add a startup/readiness diagnostic for unsupported sandbox primitives without attempting an unsandboxed fallback.
- Run existing exec policy/HITL/subresource, workspace-path, and CI agent-isolation tests.
- Add a regression test that sentinel code is not executed when SRT settings are missing/invalid or launch fails.
- Review final effective filesystem and network policy for least privilege; run the matrix against sensitive Shoggoth paths and concurrent sessions.
- Update the README plan with any evidence-driven design addenda and migration/operator instructions.

**Files:**

- `Dockerfile`
- `docker/entrypoint.sh` or daemon startup/health module (only if needed)
- `docker-compose.yml` and CI workflow/container tests as required
- `packages/os-exec/test/` security integration tests
- Relevant daemon policy/HITL tests
- `plans/2026-10-15_sandboxed-exec/README.md` and `spec.md`

## Completion Checklist

- [ ] Candidate SRT version and lockfile entry fixed.
- [ ] Production-like Linux container proof passes under agent credentials.
- [ ] Untrusted command cannot read or write outside the explicit policy by multiple methods.
- [ ] Network remains denied unless trusted policy explicitly permits a reviewed domain.
- [ ] No unsandboxed fallback exists on any startup/configuration failure.
- [ ] Foreground, extended, background, yielded, timeout, poll, and process cleanup are covered.
- [ ] Existing HITL, tool policy, output contracts, and path validation remain green.
- [ ] Operator deployment and troubleshooting documentation is complete.
