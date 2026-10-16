---
date: 2026-10-15
completed: never
---

# Sandboxed Shell Execution

## Summary

Replace the direct process-launch path behind `builtin-exec` with a Bash invocation enclosed by Anthropic's `@anthropic-ai/sandbox-runtime` (SRT). SRT's OS-enforced filesystem policy should become the primary workspace boundary for every command and descendant process, while preserving Shoggoth's existing execution, output, timeout, and approval contracts.

## Motivation

Shoggoth currently offers an intentionally curated set of file and process tools, and `builtin-exec` already runs commands as the lower-privilege agent UID. That UID/DAC separation is useful defense in depth, but it does not enforce a per-workspace boundary on commands running as the same agent identity: a shell, Python script, or alternate utility can access anything that identity can access. Shoggoth also carries path validation and a growing suite of specialized file tools to mediate operations. SRT can enforce filesystem restrictions at the OS boundary across the process tree, independent of whether a command uses `cat`, `sed`, Python, or another method.

This plan evaluates SRT as the confinement mechanism for `builtin-exec`; it does not assume that all curated file tools should be removed. Those tools also provide structured interfaces, size limits, edit semantics, and safety checks that a shell does not replace.

## Design

Keep the existing `builtin-exec` API, policy/HITL handling, output/result formats, and process ownership model. Change the os-exec execution layer so every foreground and procman-managed invocation runs through SRT, with Bash as the command interpreter. Preserve argv as data by shell-quoting each argument before constructing the script; extended exec already builds a shell command, and the plain path currently executes argv directly, so both paths need explicit compatibility coverage.

Generate sandbox policy from the resolved session workspace, not caller-provided paths. The agent's workspace is the only writable tree; reads are limited to the workspace plus only the minimal runtime/application roots required by current tools (currently `builtin-read` has an explicit `/app` additional-read allowance). Deny network access by default unless an explicit, reviewed compatibility decision requires otherwise. Never fall back to unsandboxed execution if settings are missing/invalid, SRT cannot start, or the host sandbox primitive is unavailable. Keep existing workspace-path checks as defense in depth for Shoggoth-managed reads, writes, output files, and workdirs.

SRT's README documents OS-level confinement via bubblewrap on Linux and deny-by-default network controls; it also describes the package as a beta/research preview. The project is Docker-first, launches exec children as UID/GID 900, and currently grants the daemon SETUID/SETGID capabilities. Therefore, confirm the supported SRT invocation and kernel/container prerequisites under that exact identity and deployment before choosing a library-vs-CLI adapter. The chosen integration must support concurrent sessions with invocation-specific settings without shared mutable policy, prevent the agent from changing policy for later commands, and clean up all temporary resources. SRT's per-command settings mechanism and its 0.0.79 API/CLI are upstream observations as of this plan date, not a guarantee of compatibility; pin and test the selected dependency version.

Background/yielded exec must start under the same sandbox as foreground exec and remain confined for its entire lifetime. Procman must continue to track/terminate the wrapped process tree, enforce timeouts, and capture output correctly. Preserve existing approval/subresource behavior: sandboxing narrows what an approved command can do; it must not bypass HITL or tool policy.

The implementation should include a small security-focused conformance suite which attempts reads and writes both inside and outside an isolated workspace using multiple mechanisms (shell redirection, standard utilities, and a script interpreter), plus symlink/path-traversal cases. Run real OS-backed tests in the supported Linux container environment; unit tests alone cannot establish a kernel-enforced boundary.

## Testing Strategy

Use red/green TDD. Add unit tests for policy derivation, argument quoting, sandbox invocation errors, exit/signal/timeout propagation, and settings isolation. Add integration tests running the actual SRT/bubblewrap path under the agent UID: allowed workspace reads/writes succeed; outside-workspace reads and writes fail through `cat`, shell redirection, and Python; traversal and symlink escapes fail; network is denied by default; malformed/missing config and unavailable sandbox support fail closed. Exercise both direct and extended exec, file-output paths, background/yield/poll, timeout and process-group termination, plus existing HITL and policy tests. Run the os-exec and daemon suites, typecheck, and the repository's container/CI isolation test where available.

## Considerations

- SRT is a beta/research preview, and its API, configuration, packaging and platform behavior may change. Pin a version, track upstream changes, and have an explicit dependency-update test path.
- Bubblewrap/user namespaces, seccomp, mount operations, and network isolation may be restricted by the production container runtime, host kernel, or deployment. Do not add broad container capabilities or enable weaker isolation silently to make tests pass.
- A filesystem allowlist must include the executable, libraries, runtime files, and only necessary app roots without accidentally permitting broad home, host, daemon, state, config, vault, socket, or credential paths. Check symlink behavior and writes through hardlinks/mounts as well as lexical traversal.
- Existing shell commands may rely on network access, tools in `/app`, custom environment, or HOME/XDG behavior. Explicitly identify compatibility changes and retain only those accesses required by tested workflows.
- SRT's filesystem settings are applied when the sandbox starts; configuration must be immutable to the agent and safe with concurrent invocations.
- OS sandboxing is defense in depth, not a replacement for agent UID/DAC isolation, HITL, command policy, or Shoggoth-managed path validation.
- Curated tools may be separately considered for deprecation only after broad cross-package usage research and confirmation that their non-confinement semantics remain needed or are replaced. That cleanup is outside the initial implementation unless specifically justified.
- Clarify supported deployment OS. Shoggoth's Docker-first production target is Linux; macOS/Windows developer support may need separate policy and test expectations.

## Migration

No persisted data migration is expected. Add the pinned SRT runtime dependency and its lockfile entry. Deployment images must include required SRT runtime assets and Linux sandbox prerequisites, or fail startup/readiness with a clear diagnostic rather than silently running unsandboxed. Existing `builtin-exec` callers retain their request/response schema, although commands that depend on out-of-workspace files or network access may be denied and should receive actionable errors.

## References

- [`spec.md`](spec.md) — sandbox policy, invocation contract, and security invariants
- [`implementation.md`](implementation.md) — phased implementation steps
- [Anthropic Sandbox Runtime README](https://github.com/anthropics/sandbox-runtime) — SRT usage, filesystem/network rules, Linux bubblewrap backend, and beta status (consulted 2026-10-15)
- [SRT package metadata](https://registry.npmjs.org/@anthropic-ai%2fsandbox-runtime) — latest observed package version 0.0.79 and Node engine requirement (consulted 2026-10-15)
- `packages/os-exec/src/tools.ts` — exec and extended exec implementation
- `packages/os-exec/src/subprocess.ts` — agent-UID process launch, output collection, timeout/process-group termination
- `packages/os-exec/src/workspace-path.ts` — current Shoggoth-managed path validation
- `packages/daemon/src/sessions/builtin-handlers/exec-handler.ts` — builtin exec argument mapping
- `Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml` — runtime image, agent identity, and deployment capabilities
