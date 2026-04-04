import { invokeControlRequest } from "@shoggoth/daemon/lib";
import { loadLayeredConfig, LAYOUT } from "@shoggoth/shared";

export function printConfigHelp(version: string): void {
  console.log(`${version}

Usage:
  shoggoth config show [--dynamic]   Print effective layered config (JSON, redacted)
                                      --dynamic  Show only dynamic config fragments`);
}

function controlAuth(): { kind: "operator_token"; token: string } {
  const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  if (!token) throw new Error("SHOGGOTH_OPERATOR_TOKEN is required");
  return { kind: "operator_token", token };
}

function socketPathFromEnv(configPath: string): string {
  const fromEnv = process.env.SHOGGOTH_CONTROL_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const config = loadLayeredConfig(configPath);
  return config.socketPath;
}

export async function runConfigShow(opts?: { dynamic?: boolean }): Promise<void> {
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();
  const payload = opts?.dynamic ? { dynamic: true } : {};
  const res = await invokeControlRequest({
    socketPath,
    auth,
    op: "config_show",
    payload,
  });
  if (res.ok) {
    const result = res.result as Record<string, unknown> | undefined;
    if (opts?.dynamic) {
      console.log(JSON.stringify(result?.fragments ?? result, null, 2));
    } else {
      console.log(JSON.stringify(result?.config ?? result, null, 2));
    }
  } else {
    console.error(JSON.stringify(res.error ?? res, null, 2));
    process.exitCode = 1;
  }
}
