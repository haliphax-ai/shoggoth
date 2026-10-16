# Specification

## Interfaces

Keep the public builtin tool request and result schemas unchanged in the first integration. Add an internal, immutable sandbox policy derived by trusted daemon/os-exec code from the canonical session workspace and explicit runtime configuration.

```ts
/** Trusted per-invocation policy; paths are canonicalized before this is built. */
interface ExecSandboxPolicy {
  workspaceRoot: string;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  allowedDomains: readonly string[]; // Empty by default.
  deniedDomains: readonly string[];
}

interface SandboxedExecOptions {
  command: string;
  cwd: string;
  uid: number;
  gid: number;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutSeconds?: number;
  policy: ExecSandboxPolicy;
  /** Stable random invocation identifier for logs/cleanup; not agent-controlled. */
  invocationId: string;
}
```

The plan intentionally leaves the exact SRT integration signature open pending prototype evaluation: use the library if it can safely and concurrently produce a command/process invocation with per-call immutable policy, otherwise use its supported CLI/settings interface. Do not invoke a constructed shell command with `shell: true` unless argument quoting has been proven safe. Prefer spawn with an explicit executable and argument vector when the selected SRT interface supports it.

## Sandbox invariants

1. The canonical workspace of the current session is the sole writable root for command processes.
2. Reads are limited to that workspace and the minimal explicit runtime roots established by compatibility tests; do not grant broad `/`, `/home`, `/var/lib/shoggoth`, `/run`, or daemon roots for convenience.
3. Network is deny-by-default; any allowlist is trusted configuration, not a tool argument or environment override.
4. No command path (plain, extended, background, yielded, or child process) executes outside SRT.
5. Missing, malformed, untrusted, or uncreatable settings, sandbox startup errors, and unsupported sandbox primitives produce a nonzero/tool error and never trigger an unsandboxed retry.
6. Agent-supplied `env`, shell content, `workdir`, and output paths cannot override sandbox policy or write outside its allowed roots.
7. Sandbox wrapper, intermediate shell, and all descendants remain in a process group that procman/timeout cleanup can terminate.
8. Existing HITL and tool-policy gates remain authoritative and precede execution.

SRT v0.0.79 metadata reports Node >=22.12.0; the project's container uses Node 22. Upstream README describes Linux via bubblewrap and filesystem writes as allow-only, but reads as deny-then-allow. The exact effective policy must be proven against the pinned version because an omitted/empty `allowRead` is not an allowlist by itself.

## API / Function Signatures

Suggested internal boundary (names may change to fit existing conventions):

```ts
/** Build and validate a policy without using agent-controlled values. */
function buildExecSandboxPolicy(input: {
  workspaceRoot: string;
  runtimeReadRoots: readonly string[];
  allowedDomains?: readonly string[];
}): ExecSandboxPolicy;

/** Run one shell invocation under an OS-enforced sandbox. */
function runSandboxedExec(options: SandboxedExecOptions): Promise<RunAsUserResult>;
```

The runner owns policy/settings materialization, SRT startup, process launch, output collection, and cleanup. Its process result remains compatible with `RunAsUserResult`; higher-level extended-exec output truncation and file-output handling continue to work, with all file writes constrained both by SRT and existing `resolvePathForWrite` validation.

## Policy mapping

Map trusted roots to SRT's filesystem configuration only after verifying the pinned API semantics and backend implementation:

- `allowWrite`: canonical workspace only (plus any narrowly justified temporary runtime path if the prototype proves strictly necessary; default none).
- `denyWrite`: explicitly protect sensitive paths even if nested beneath any broad writable mount/root. Prefer no broad write grants.
- `allowRead`/`denyRead`: establish workspace and explicitly required app/runtime reads while denying broader sensitive roots. Never rely on defaults for the intended read boundary.
- `network.allowedDomains`: empty by default; denied paths remain denied by OS/platform policy.

SRT settings transport must be private to the daemon and not writable by the agent. If settings live on disk, use a daemon-owned 0700 directory and per-invocation 0600 files or a documented secure library configuration route. Do not use a shared mutable settings file for concurrent commands. Delete temporary files and stop any per-invocation resources after all children exit.

The policy's exact root list should be derived from integration tests and upstream SRT behavior, not guessed. Validate canonical paths, reject workspace symlinks that resolve outside the intended session root, and confirm the sandbox cannot use symlink replacement, `..`, `/proc`, `/dev/fd`, hardlinks, or bind mounts to bypass it.

## Code Examples

Conceptual only; confirm against pinned SRT API before implementation:

```ts
const policy = buildExecSandboxPolicy({
  workspaceRoot: canonicalSessionWorkspace,
  runtimeReadRoots: ["/app"], // Only if required and narrowly mounted/read-only.
  allowedDomains: [],
});

const result = await runSandboxedExec({
  command: quoteArgvForBash(argv),
  cwd: validatedCwd,
  uid: agentUid,
  gid: agentGid,
  env: trustedEnvWithAgentOverrides,
  policy,
  invocationId: randomUUID(),
});
```

Conformance cases include: workspace file readable and writable by all supported mechanisms; sibling workspace, operator, daemon state, vault key, `/etc/shoggoth`, and `/run/shoggoth` inaccessible; outside writes rejected; denied network connection fails; sandbox startup/configuration failure returns an error and does not run a marker command on the host.
