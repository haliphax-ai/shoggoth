import { LAYOUT, VERSION } from "@shoggoth/shared";
import { controlAuth, formatTable, printSubcommandHelpHint, socketPathFromEnv } from "./cli-utils";
import { invokeControlRequest } from "@shoggoth/daemon/lib";

function printQueueHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth queue list [--session <id>] [--priority system|user|all]
  shoggoth queue remove [--session <id>] [--priority system|user|all] [--index N] [--range N-M] [--count N]
  shoggoth queue clear [--session <id>] [--priority system|user|all]

Index and range values are 1-based, matching the Index column of the list output.`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

export async function runQueueCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printQueueHelp();
    return;
  }

  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = await socketPathFromEnv(configDir);
  const auth = controlAuth();
  const action = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!["list", "remove", "clear"].includes(action)) {
    printQueueHelp();
    printSubcommandHelpHint("queue");
    process.exitCode = 1;
    return;
  }

  const sessionId = args.session;
  if (!sessionId) {
    console.error("error: --session is required");
    process.exitCode = 1;
    return;
  }

  const payload: Record<string, unknown> = {
    session_id: sessionId,
    action,
  };
  if (args.priority) payload.priority = args.priority;

  if (action === "remove") {
    if (args.index !== undefined) {
      payload.by = "index";
      payload.index = Number(args.index);
    } else if (args.range) {
      const parts = args.range.split("-");
      const s = Number(parts[0]);
      const e = Number(parts[1]);
      const valid =
        parts.length === 2 &&
        parts[0].trim() !== "" &&
        parts[1].trim() !== "" &&
        Number.isFinite(s) &&
        Number.isFinite(e);
      if (!valid) {
        console.error("error: --range must be two numbers separated by '-' (e.g. 3-7)");
        process.exitCode = 1;
        return;
      }
      payload.by = "range";
      payload.start = s;
      payload.end = e;
    } else if (args.count !== undefined) {
      payload.by = "count";
      payload.count = Number(args.count);
    } else {
      console.error("error: remove requires --index, --range, or --count");
      process.exitCode = 1;
      return;
    }
  }

  const res = await invokeControlRequest({
    socketPath,
    auth,
    op: "session_queue_manage",
    payload,
  });

  if (!res.ok) {
    console.error(`error: ${(res.error as { message?: string })?.message ?? "unknown"}`);
    process.exitCode = 1;
    return;
  }

  const result = res.result as Record<string, unknown>;

  if (action === "list") {
    const entries = result.entries as Array<{
      index: number;
      priority: string;
      label: string;
      enqueuedAt: number;
    }>;
    if (entries.length === 0) {
      console.log("Queue is empty.");
      return;
    }
    const header = ["Index", "Priority", "Label", "Enqueued"];
    const rows = entries.map((e) => [
      String(e.index),
      e.priority,
      e.label,
      new Date(e.enqueuedAt).toISOString(),
    ]);
    formatTable(header, rows);
    return;
  }

  console.log(`Removed ${result.removed ?? 0} entries.`);
}
