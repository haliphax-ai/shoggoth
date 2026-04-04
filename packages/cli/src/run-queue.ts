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

function printQueueHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth queue list [--session <id>] [--priority system|user|all]
  shoggoth queue remove [--session <id>] [--priority system|user|all] [--index N] [--range N-M] [--count N]
  shoggoth queue clear [--session <id>] [--priority system|user|all]`);
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
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();
  const action = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!["list", "remove", "clear"].includes(action)) {
    printQueueHelp();
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
      const [s, e] = args.range.split("-").map(Number);
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
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );
    const pad = (s: string, w: number) => s.padEnd(w);
    console.log(header.map((h, i) => pad(h, widths[i])).join("  "));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) {
      console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
    }
    return;
  }

  console.log(`Removed ${result.removed ?? 0} entries.`);
}
