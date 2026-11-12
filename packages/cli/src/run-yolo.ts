import { LAYOUT, VERSION } from "@shoggoth/shared";
import { controlAuth, printSubcommandHelpHint, socketPathFromEnv } from "./cli-utils";
import { invokeControlRequest } from "@shoggoth/daemon/lib";

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
    printSubcommandHelpHint("yolo");
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
