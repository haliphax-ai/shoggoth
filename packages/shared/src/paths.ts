/**
 * Canonical filesystem layout (v1). Daemon-owned trees are not traversable by agent UID
 * when entrypoint permissions are applied (see docker/entrypoint.sh).
 */

/**
 * Basename under {@link LAYOUT.operatorDir} (or config `operatorDirectory`) for gateway-injected
 * system prompt text. Not a workspace file — agents cannot read it via builtin read/exec.
 */
export const OPERATOR_GLOBAL_INSTRUCTIONS_BASENAME = "GLOBAL.md" as const;

export const LAYOUT = {
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
} as const;
