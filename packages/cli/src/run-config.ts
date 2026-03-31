import { loadLayeredConfig, redactDeep, LAYOUT } from "@shoggoth/shared";

export function printConfigHelp(version: string): void {
  console.log(`shoggoth ${version}

Usage:
  shoggoth config show   Print effective layered config (JSON)`);
}

export function runConfigShow(): void {
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const config = loadLayeredConfig(configDir);
  const jsonPaths = config.policy.auditRedaction.jsonPaths;
  const redacted = redactDeep(config, jsonPaths);
  console.log(JSON.stringify(redacted, null, 2));
}
