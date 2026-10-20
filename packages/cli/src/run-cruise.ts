import { loadLayeredConfigAsync, LAYOUT, VERSION } from "@shoggoth/shared";
import { invokeControlRequest, resolveSessionTargetFromCliArg } from "@shoggoth/daemon/lib";

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

async function resolveSessionTargetOrExit(configDir: string, raw: string): Promise<string | null> {
  const config = await loadLayeredConfigAsync(configDir);
  try {
    return resolveSessionTargetFromCliArg(raw, config);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return null;
  }
}

function printCruiseHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth cruise <sessionId|agentId> --yes <guidance> --no <guidance>
        [--escalate <guidance>] [--model <provider/model>]
                              Activate (or change) cruise control for a session
  shoggoth cruise status <sessionId|agentId>
                              Show whether cruise control is active
  shoggoth cruise off <sessionId|agentId>
                              Deactivate cruise control

Cruise control routes HITL approval requests that do not pass auto-approvals
to a decision-model judge that approves or denies them automatically.`);
}

export async function runCruiseCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printCruiseHelp();
    return;
  }
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;

  const sub = argv[0];
  if (sub === "status" || sub === "off") {
    const rawTarget = argv[1]?.trim();
    if (!rawTarget) {
      console.error(`usage: shoggoth cruise ${sub} <sessionId|agentId>`);
      process.exitCode = 1;
      return;
    }
    const sessionId = await resolveSessionTargetOrExit(configDir, rawTarget);
    if (!sessionId) return;
    const socketPath = await socketPathFromEnv(configDir);
    const res = await invokeControlRequest({
      socketPath,
      auth: controlAuth(),
      op: "hitl_cruise_control",
      payload:
        sub === "off" ? { session_id: sessionId, deactivate: true } : { session_id: sessionId },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  // Activate: target + flags.
  const targetRaw = sub.trim();
  if (targetRaw.startsWith("--")) {
    console.error(
      "usage: shoggoth cruise <sessionId|agentId> --yes <guidance> --no <guidance> [--escalate <guidance>] [--model <provider/model>]",
    );
    process.exitCode = 1;
    return;
  }
  const flags: Record<string, string> = {};
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--yes" || t === "--no" || t === "--escalate" || t === "--model") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        console.error(`usage: shoggoth cruise ... ${t} <guidance>`);
        process.exitCode = 1;
        return;
      }
      flags[t.slice(2)] = v;
      i += 1;
      continue;
    }
    console.error(`unknown argument: ${t}`);
    process.exitCode = 1;
    return;
  }
  if (!flags.yes || !flags.no) {
    console.error("both --yes and --no guidance are required to activate cruise control");
    process.exitCode = 1;
    return;
  }
  const sessionId = await resolveSessionTargetOrExit(configDir, targetRaw);
  if (!sessionId) return;
  const socketPath = await socketPathFromEnv(configDir);
  const res = await invokeControlRequest({
    socketPath,
    auth: controlAuth(),
    op: "hitl_cruise_control",
    payload: {
      session_id: sessionId,
      yes: flags.yes,
      no: flags.no,
      ...(flags.escalate ? { escalate: flags.escalate } : {}),
      ...(flags.model ? { model: flags.model } : {}),
    },
  });
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) {
    process.exitCode = 1;
    return;
  }
  // Surface activation warnings (e.g. missing model) on stderr.
  const warnings = (res.result as { warnings?: string[] } | undefined)?.warnings ?? [];
  for (const w of warnings) {
    console.error(`warning: ${w}`);
  }
}
