/**
 * Config keys that require a full process restart (no in-process reload).
 * Aligns with {@link ShoggothConfig} in @shoggoth/shared.
 *
 * **Hot-reload (in-process):** when `SHOGGOTH_CONFIG_HOT_RELOAD` is not `0`, the daemon
 * watches `configDirectory` and reapplies **policy** and **HITL** from disk if the merged
 * config stays equal on every key listed here. Changes to any restart-required key are
 * logged and ignored until restart. Other subtrees (`models`, `mcp`, `skills`, `plugins`,
 * `memory`, `retention`, `logLevel`, …) are **not** applied live yet — adjust those and
 * restart the daemon (see `docs/runbook.md`).
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


