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

function printHitlHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth hitl list [sessionId]   List pending HITL actions (JSON via control socket)
  shoggoth hitl get <id>           Fetch one pending row (JSON)
  shoggoth hitl approve <id>       Approve pending tool (JSON)
  shoggoth hitl deny <id>          Deny pending tool (JSON)
  shoggoth hitl clear <agent id>   Clear pending HITL rows (use agent id \`all\` for every agent)
    [--session <session URN>]      Only this session; leaves auto-approve state unchanged
    [--noauto]                     Clear pending only; keep session + agent auto-approve`);
}

export async function runHitlCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printHitlHelp();
    return;
  }
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();

  const sub = argv[0];
  if (sub === "list") {
    const sessionId = argv[1]?.trim();
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "hitl_pending_list",
      payload: sessionId ? { session_id: sessionId } : {},
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "get") {
    const id = argv[1]?.trim();
    if (!id) {
      console.error("usage: shoggoth hitl get <pendingId>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "hitl_pending_get",
      payload: { id },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "approve") {
    const id = argv[1]?.trim();
    if (!id) {
      console.error("usage: shoggoth hitl approve <pendingId>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "hitl_pending_approve",
      payload: { id },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "deny") {
    const id = argv[1]?.trim();
    if (!id) {
      console.error("usage: shoggoth hitl deny <pendingId>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "hitl_pending_deny",
      payload: { id },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "clear") {
    const tail = argv.slice(1);
    const agentId = tail[0]?.trim();
    if (!agentId) {
      console.error(
        "usage: shoggoth hitl clear <agent id|all> [--session <session URN>] [--noauto]",
      );
      process.exitCode = 1;
      return;
    }
    let sessionId: string | undefined;
    let noAuto = false;
    for (let i = 1; i < tail.length; i++) {
      const t = tail[i];
      if (t === "--session") {
        const v = tail[i + 1]?.trim();
        if (!v) {
          console.error("usage: shoggoth hitl clear ... --session <session URN>");
          process.exitCode = 1;
          return;
        }
        sessionId = v;
        i += 1;
        continue;
      }
      if (t === "--noauto") {
        noAuto = true;
        continue;
      }
      console.error(`unknown argument: ${t}`);
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "hitl_clear",
      payload: {
        agent_id: agentId,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(noAuto ? { no_auto: true } : {}),
      },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  console.error(
    `usage: shoggoth hitl list [sessionId] | get <id> | approve <id> | deny <id> | clear <agent id|all> ...`,
  );
  process.exitCode = 1;
}
