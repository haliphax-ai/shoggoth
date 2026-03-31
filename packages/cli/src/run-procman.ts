import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";
import { invokeControlRequest } from "@shoggoth/daemon/lib";

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

function printProcmanHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth procman list             List managed processes
  shoggoth procman restart <id>     Restart a managed process
  shoggoth procman stop <id>        Stop a managed process`);
}

function formatUptime(ms: number): string {
  if (ms <= 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function formatOwner(owner: { kind: string; scopeId?: string }): string {
  return owner.scopeId ? `${owner.kind}:${owner.scopeId}` : owner.kind;
}

export async function runProcmanCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printProcmanHelp();
    return;
  }

  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();

  if (argv[0] === "list") {
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "procman_list",
      payload: {},
    });
    if (!res.ok) {
      console.error(`error: ${(res.error as { message?: string })?.message ?? "unknown"}`);
      process.exitCode = 1;
      return;
    }
    const { processes } = res.result as {
      processes: Array<{
        id: string;
        label: string | null;
        state: string;
        pid: number | null;
        uptimeMs: number;
        restartCount: number;
        lastExitCode: number | null;
        owner: { kind: string; scopeId?: string };
      }>;
    };
    if (processes.length === 0) {
      console.log("No managed processes.");
      return;
    }
    // Table output
    const header = ["ID", "State", "PID", "Uptime", "Restarts", "Owner"];
    const rows = processes.map((p) => [
      p.id,
      p.state,
      p.pid != null ? String(p.pid) : "-",
      formatUptime(p.uptimeMs),
      String(p.restartCount),
      formatOwner(p.owner),
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

  if (argv[0] === "restart") {
    const id = argv[1];
    if (!id) {
      console.error("usage: shoggoth procman restart <id>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "procman_restart",
      payload: { id },
    });
    if (!res.ok) {
      console.error(`error: ${(res.error as { message?: string })?.message ?? "unknown"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Restarted: ${id}`);
    return;
  }

  if (argv[0] === "stop") {
    const id = argv[1];
    if (!id) {
      console.error("usage: shoggoth procman stop <id>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "procman_stop",
      payload: { id },
    });
    if (!res.ok) {
      console.error(`error: ${(res.error as { message?: string })?.message ?? "unknown"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Stopped: ${id}`);
    return;
  }

  printProcmanHelp();
  process.exitCode = 1;
}
