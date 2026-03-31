import { invokeControlRequest } from "@shoggoth/daemon/lib";
import { loadLayeredConfig, LAYOUT } from "@shoggoth/shared";

export function printConfigHelp(version: string): void {
  console.log(`${version}

Usage:
  shoggoth config show   Print effective layered config (JSON, redacted)`);
}

function controlAuth():
  | { kind: "operator_token"; token: string }
  | { kind: "operator_peercred" } {
  const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  if (token) return { kind: "operator_token", token };
  return { kind: "operator_peercred" };
}

function socketPathFromEnv(configPath: string): string {
  const fromEnv = process.env.SHOGGOTH_CONTROL_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const config = loadLayeredConfig(configPath);
  return config.socketPath;
}

export async function runConfigShow(): Promise<void> {
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();
  const res = await invokeControlRequest({
    socketPath,
    auth,
    op: "config_show",
    payload: {},
  });
  if (res.ok) {
    const result = res.result as Record<string, unknown> | undefined;
    console.log(JSON.stringify(result?.config ?? result, null, 2));
  } else {
    console.error(JSON.stringify(res.error ?? res, null, 2));
    process.exitCode = 1;
  }
}
