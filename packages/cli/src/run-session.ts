import { invokeControlRequest, resolveSessionTargetFromCliArg } from "@shoggoth/daemon/lib";
import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";
import { runSessionCompact } from "./run-session-compact";

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

function resolveSessionTargetOrExit(configDir: string, raw: string): string | null {
  const config = loadLayeredConfig(configDir);
  try {
    return resolveSessionTargetFromCliArg(raw, config);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return null;
  }
}

function printSessionHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth session list [status] [--agent <agentId>]   List sessions (optional filters; JSON)
  shoggoth session send <sessionUrn|agentId> [--silent] <message...>  Inject user message + model turn (operator)
  shoggoth session compact <sessionUrn|agentId> [--force]  Transcript compact (state DB); JSON on stdout
  shoggoth session context new <sessionUrn|agentId>   New context segment (control socket; operator)
  shoggoth session context reset <sessionUrn|agentId>  Reset context segment (control socket; operator)
  shoggoth session inspect <sessionUrn|agentId>   Session row + child subagents (operator)
  shoggoth session steer <sessionUrn|agentId> <post|discord|surface|internal> <prompt...>  Extra model turn (operator)
  shoggoth session abort <sessionUrn|agentId>  Abort in-flight model turn (operator)
  shoggoth session kill <sessionUrn|agentId>      Terminate session + cleanup (operator)

  session send: --silent skips posting the assistant reply to the bound messaging surface (internal delivery only).`);
}

function parseSessionListArgv(
  parts: string[],
): { help: true } | { status?: string; agent?: string } {
  let status: string | undefined;
  let agent: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!;
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--agent") {
      const v = parts[i + 1]?.trim();
      if (!v) {
        throw new Error("--agent requires a value");
      }
      agent = v;
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (status !== undefined) {
      throw new Error("only one positional status token allowed");
    }
    status = a;
  }
  return { status, agent };
}

/**
 * Subcommands after `shoggoth session` (e.g. `compact`, `context`).
 */
export async function runSessionCli(argv: string[]): Promise<void> {
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printSessionHelp();
    return;
  }
  const sub = argv[0];
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();

  if (sub === "list") {
    const rest = argv.slice(1);
    let listOpts: { status?: string; agent?: string };
    try {
      const parsed = parseSessionListArgv(rest);
      if ("help" in parsed) {
        printSessionHelp();
        return;
      }
      listOpts = parsed;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      console.error("usage: shoggoth session list [status] [--agent <agentId>]");
      process.exitCode = 1;
      return;
    }
    const payload: Record<string, unknown> = {};
    if (listOpts.status) payload.status = listOpts.status;
    if (listOpts.agent) payload.agent = listOpts.agent;
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "session_list",
      payload,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "send") {
    const rest = argv.slice(1);
    let silent = false;
    const tokens: string[] = [];
    for (const t of rest) {
      if (t === "--silent") {
        silent = true;
        continue;
      }
      tokens.push(t);
    }
    const rawTarget = tokens[0]?.trim();
    const message = tokens.slice(1).join(" ").trim();
    if (!rawTarget || !message) {
      console.error(
        "usage: shoggoth session send <sessionUrn|agentId> [--silent] <message...>",
      );
      process.exitCode = 1;
      return;
    }
    const sessionId = resolveSessionTargetOrExit(configDir, rawTarget);
    if (!sessionId) return;
    const payload: Record<string, unknown> = { session_id: sessionId, message };
    if (silent) payload.silent = true;
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "session_send",
      payload,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "compact") {
    const rest = argv.slice(1).filter((a) => a !== "--force");
    const rawTarget = rest[0]?.trim();
    const force = argv.includes("--force");
    if (!rawTarget) {
      console.error(
        "usage: shoggoth session compact <sessionUrn|agentId> [--force]\n" +
          "  sessionUrn: full agent:… id; agentId: resolves to that agent’s main (bootstrap primary) session",
      );
      process.exitCode = 1;
      return;
    }
    const config = loadLayeredConfig(configDir);
    let sessionId: string;
    try {
      sessionId = resolveSessionTargetFromCliArg(rawTarget, config);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
      return;
    }
    const out = await runSessionCompact({
      stateDbPath: config.stateDbPath,
      models: config.models,
      sessionId,
      force,
    });
    console.log(JSON.stringify(out));
    return;
  }

  if (sub === "context") {
    const action = argv[1];
    const rawTarget = argv[2]?.trim();
    if ((action !== "new" && action !== "reset") || !rawTarget) {
      console.error(
        "usage: shoggoth session context new <sessionUrn|agentId>\n" +
          "       shoggoth session context reset <sessionUrn|agentId>",
      );
      process.exitCode = 1;
      return;
    }
    const config = loadLayeredConfig(configDir);
    let sessionId: string;
    try {
      sessionId = resolveSessionTargetFromCliArg(rawTarget, config);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
      return;
    }
    await invokeSessionContextControl(configDir, action, sessionId);
    return;
  }

  if (sub === "inspect") {
    const rawTarget = argv[1]?.trim();
    if (!rawTarget) {
      console.error("usage: shoggoth session inspect <sessionUrn|agentId>");
      process.exitCode = 1;
      return;
    }
    const sessionId = resolveSessionTargetOrExit(configDir, rawTarget);
    if (!sessionId) return;
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "session_inspect",
      payload: { session_id: sessionId },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "steer") {
    const rawTarget = argv[1]?.trim();
    const deliveryRaw = argv[2]?.trim().toLowerCase();
    const prompt = argv.slice(3).join(" ").trim();
    const deliveryInternal = deliveryRaw === "internal";
    const deliveryPost =
      deliveryRaw === "post" || deliveryRaw === "discord" || deliveryRaw === "surface";
    if (!rawTarget || (!deliveryInternal && !deliveryPost) || !prompt) {
      console.error(
        "usage: shoggoth session steer <sessionUrn|agentId> <post|discord|surface|internal> <prompt...>",
      );
      process.exitCode = 1;
      return;
    }
    const sessionId = resolveSessionTargetOrExit(configDir, rawTarget);
    if (!sessionId) return;
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      prompt,
    };
    if (deliveryInternal) payload.delivery = "internal";
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "session_steer",
      payload,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "abort") {
    const rawTarget = argv[1]?.trim();
    if (!rawTarget) {
      console.error("usage: shoggoth session abort <sessionUrn|agentId>");
      process.exitCode = 1;
      return;
    }
    const sessionId = resolveSessionTargetOrExit(configDir, rawTarget);
    if (!sessionId) return;
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "session_abort",
      payload: { session_id: sessionId },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "kill") {
    const rawTarget = argv[1]?.trim();
    if (!rawTarget) {
      console.error("usage: shoggoth session kill <sessionUrn|agentId>");
      process.exitCode = 1;
      return;
    }
    const sessionId = resolveSessionTargetOrExit(configDir, rawTarget);
    if (!sessionId) return;
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "session_kill",
      payload: { session_id: sessionId },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  printSessionHelp();
  process.exitCode = 1;
}

async function invokeSessionContextControl(
  configDir: string,
  action: "new" | "reset",
  sessionId: string,
): Promise<void> {
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();
  const op = action === "new" ? "session_context_new" : "session_context_reset";
  const res = await invokeControlRequest({
    socketPath,
    auth,
    op,
    payload: { session_id: sessionId },
  });
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exitCode = 1;
}
