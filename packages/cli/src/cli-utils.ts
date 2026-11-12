import { resolveSessionTargetFromCliArg } from "@shoggoth/daemon/lib";
import { loadLayeredConfigAsync } from "@shoggoth/shared";

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
  const config = await loadLayeredConfigAsync(configDir);
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
  const config = await loadLayeredConfigAsync(configDir);
  try {
    return resolveSessionTargetFromCliArg(raw, config);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return null;
  }
}
