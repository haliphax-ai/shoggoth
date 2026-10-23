import { loadLayeredConfigAsync, LAYOUT, VERSION } from "@shoggoth/shared";
import { invokeControlRequest } from "@shoggoth/daemon/lib";

function controlAuth(): { kind: "operator_token"; token: string } {
  const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  if (!token) throw new Error("SHOGGOTH_OPERATOR_TOKEN is required");
  return { kind: "operator_token", token };
}

async function socketPathFromEnv(configPath: string): Promise<string> {
  const fromEnv = process.env.SHOGGOTH_CONTROL_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const config = await loadLayeredConfigAsync(configPath);
  return config.socketPath;
}

function printYoloHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth yolo on <session-id>     Auto-approve HITL for the session until cleared
  shoggoth yolo off <session-id>    Clear the yolo flag
  shoggoth yolo status <session-id> Show whether the flag is set`);
}

export async function runYoloCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printYoloHelp();
    return;
  }
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = await socketPathFromEnv(configDir);
  const auth = controlAuth();

  const action = argv[0];
  if (action !== "on" && action !== "off" && action !== "status") {
    printYoloHelp();
    process.exitCode = 1;
    return;
  }
  const sessionId = argv[1]?.trim();
  if (!sessionId) {
    console.error(`usage: shoggoth yolo ${action} <session-id>`);
    process.exitCode = 1;
    return;
  }
  const res = await invokeControlRequest({
    socketPath,
    auth,
    op: "yolo_mode",
    payload: { action, session_id: sessionId },
  });
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exitCode = 1;
}
