import { join } from "node:path";

/**
 * Canonical filesystem layout (v1). Daemon-owned trees are not traversable by agent UID
 * when entrypoint permissions are applied (see docker/entrypoint.sh).
 */

/**
 * Basename under {@link LAYOUT.operatorDir} (or config `operatorDirectory`) for gateway-injected
 * system prompt text. Not a workspace file — agents cannot read it via builtin read/exec.
 */
export const OPERATOR_GLOBAL_INSTRUCTIONS_BASENAME = "GLOBAL.md" as const;

/**
 * Daemon-owned directory holding exec-shell startup files for agent subprocesses
 * (e.g. the empty `BASH_ENV` target). Entrypoint enforces 0755 shoggoth:shoggoth, so
 * agent UID can search/read (keeping `BASH_ENV` handling silent) but can never create,
 * replace, or write files here — a planted startup file is impossible.
 */
export const EXEC_ENV_DIR = "/var/lib/shoggoth/exec-env" as const;

/**
 * `BASH_ENV` target for agent exec shells: an empty daemon-owned file OUTSIDE the
 * agent-writable workspace (see {@link EXEC_ENV_DIR}). The daemon never writes
 * command-relevant content to it; agents cannot create or replace it. If it is absent
 * (fresh volume before the entrypoint runs) the parent dir is still agent-traversable,
 * so bash silently skips the missing file instead of erroring.
 */
export const EXEC_BASH_ENV = join(EXEC_ENV_DIR, "bash-env");

export const LAYOUT = {
  dataRoot: "/var/lib/shoggoth",
  skillsDir: "/var/lib/shoggoth/skills",
  configDir: "/etc/shoggoth/config.d",
  stateDir: "/var/lib/shoggoth/state",
  stateDbFile: "/var/lib/shoggoth/state/shoggoth.db",
  workspacesRoot: "/var/lib/shoggoth/workspaces",
  /** Operator-only material (e.g. copies from Compose secrets); 0700 shoggoth in entrypoint — not agent-readable. */
  operatorDir: "/var/lib/shoggoth/operator",
  secretsDir: "/run/secrets",
  inboundMediaRoot: "/var/lib/shoggoth/media/inbound",
  runDir: "/run/shoggoth",
  controlSocket: "/run/shoggoth/control.sock",
  /** Daemon log files (JSON lines). Daemon-writable only — agent UID must not read this tree. */
  logDir: "/var/log/shoggoth",
} as const;
