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

export function parseMcpCancelCliArgs(argv: string[]):
  | { ok: true; payload: { session_id: string; source_id: string; request_id: number } }
  | { ok: false; message: string } {
  const sessionId = argv[0]?.trim();
  const sourceId = argv[1]?.trim();
  const requestIdRaw = argv[2]?.trim();
  if (!sessionId || !sourceId || requestIdRaw === undefined || requestIdRaw === "") {
    return {
      ok: false,
      message: "usage: shoggoth mcp cancel <sessionId> <sourceId> <requestId>",
    };
  }
  const requestId = Number(requestIdRaw);
  if (!Number.isFinite(requestId)) {
    return { ok: false, message: "requestId must be a finite number" };
  }
  return {
    ok: true,
    payload: {
      session_id: sessionId,
      source_id: sourceId,
      request_id: Math.trunc(requestId),
    },
  };
}

function printMcpHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth mcp cancel <sessionId> <sourceId> <requestId>  Cancel streamable HTTP MCP JSON-RPC id (JSON)`);
}

export async function runMcpCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printMcpHelp();
    return;
  }
  const sub = argv[0];
  if (sub === "cancel") {
    const parsed = parseMcpCancelCliArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error(parsed.message);
      process.exitCode = 1;
      return;
    }
    const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
    const socketPath = socketPathFromEnv(configDir);
    const auth = controlAuth();
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "mcp_http_cancel_request",
      payload: parsed.payload,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  console.error("usage: shoggoth mcp cancel <sessionId> <sourceId> <requestId>");
  process.exitCode = 1;
}
