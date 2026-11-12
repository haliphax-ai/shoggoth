import { resolveSessionTargetFromCliArg } from "@shoggoth/daemon/lib";
import { loadLayeredConfigCachedAsync } from "./config-cache";

/** Operator auth for control-socket requests issued by CLI subcommands. */
export function controlAuth(): { kind: "operator_token"; token: string } {
  const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  if (!token) throw new Error("SHOGGOTH_OPERATOR_TOKEN is required");
  return { kind: "operator_token", token };
}

/**
 * Resolve the daemon control socket path: env override first, then the socket
 * path from the layered config loaded from the given config directory.
 */
export async function socketPathFromEnv(configDir: string): Promise<string> {
  const fromEnv = process.env.SHOGGOTH_CONTROL_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const config = await loadLayeredConfigCachedAsync(configDir);
  return config.socketPath;
}

/**
 * Resolve a `sessionUrn|agentId` CLI argument via the daemon helper. On
 * failure, print the error and set the process exit code; the caller should
 * return early when null is returned.
 */
export async function resolveSessionTargetOrExit(
  configDir: string,
  raw: string,
): Promise<string | null> {
  const config = await loadLayeredConfigCachedAsync(configDir);
  try {
    return resolveSessionTargetFromCliArg(raw, config);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return null;
  }
}

/**
 * Run a CLI subcommand body, catching unexpected errors thrown by the
 * runner. On error: prints the error message to stderr and sets the
 * process exit code to 1. Returns true when an error was caught, false
 * otherwise; the caller is responsible for the final process exit.
 */
export async function runSubcommand(run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return true;
  }
  return false;
}

/**
 * Print a column-aligned table to stdout: left-aligned cells padded to the
 * widest entry per column, joined with a two-space gap; header row first,
 * then a dash separator row, then the data rows.
 */
export function formatTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(header.map((h, i) => pad(h, widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
  }
}
