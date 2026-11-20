/**
 * Config keys that require a full process restart (no in-process reload).
 * Aligns with {@link ShoggothConfig} in @shoggoth/shared. Hot-reload behavior
 * around these keys: docs/daemon.md → Hot-Reload.
 */
export const CONFIG_RESTART_REQUIRED_KEYS = [
  "stateDbPath",
  "socketPath",
  "controlSocketMode",
  "controlSocketUid",
  "controlSocketGid",
  "operatorTokenPath",
  "workspacesRoot",
  "secretsDirectory",
  "inboundMediaRoot",
  "configDirectory",
] as const;

export type ConfigRestartRequiredKey = (typeof CONFIG_RESTART_REQUIRED_KEYS)[number];
