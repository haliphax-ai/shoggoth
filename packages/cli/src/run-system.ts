import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";
import { invokeControlRequest } from "@shoggoth/daemon/lib";

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

function printSystemHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth system health    Run health checks against the daemon (JSON via control socket)`);
}

export async function runSystemCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printSystemHelp();
    return;
  }

  if (argv[0] === "health") {
    const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
    const socketPath = socketPathFromEnv(configDir);
    const auth = controlAuth();
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "health",
      payload: {},
    });
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.ok && (res.result as Record<string, unknown>)?.ready ? 0 : 1;
    return;
  }

  console.error("usage: shoggoth system health");
  process.exitCode = 1;
}
