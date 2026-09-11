import { loadLayeredConfigAsync, LAYOUT, VERSION } from "@shoggoth/shared";
import { invokeControlRequest } from "@shoggoth/daemon/lib";

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

function parseDuration(raw: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(raw.trim());
  if (!m) throw new Error(`Invalid duration: ${raw}. Use e.g. 5m, 300s, 1800`);
  const n = Number.parseInt(m[1], 10);
  const unit = m[2] ?? "s";
  if (unit === "h") return n * 3600 * 1000;
  if (unit === "m") return n * 60 * 1000;
  return n * 1000;
}

function printElevationHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth elevation grant <session-id> [--duration 5m]   Grant elevation (default 5m, max 30m)
  shoggoth elevation revoke <session-id>                  Revoke all grants for session
  shoggoth elevation revoke --id <grant-id>               Revoke a specific grant`);
}

export async function runElevationCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printElevationHelp();
    return;
  }
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = await socketPathFromEnv(configDir);
  const auth = controlAuth();

  const sub = argv[0];

  if (sub === "grant") {
    const sessionId = argv[1]?.trim();
    if (!sessionId) {
      console.error("usage: shoggoth elevation grant <session-id> [--duration 5m]");
      process.exitCode = 1;
      return;
    }
    let durationMs: number | undefined;
    const durIdx = argv.indexOf("--duration");
    if (durIdx >= 0) {
      const durVal = argv[durIdx + 1]?.trim();
      if (!durVal) {
        console.error("--duration requires a value (e.g. 5m, 300s)");
        process.exitCode = 1;
        return;
      }
      durationMs = parseDuration(durVal);
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "elevation_grant",
      payload: {
        session_id: sessionId,
        ...(durationMs != null ? { duration_ms: durationMs } : {}),
      },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "revoke") {
    const idIdx = argv.indexOf("--id");
    if (idIdx >= 0) {
      const grantId = argv[idIdx + 1]?.trim();
      if (!grantId) {
        console.error("--id requires a grant ID");
        process.exitCode = 1;
        return;
      }
      const res = await invokeControlRequest({
        socketPath,
        auth,
        op: "elevation_revoke",
        payload: { grant_id: grantId },
      });
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exitCode = 1;
      return;
    }
    const sessionId = argv[1]?.trim();
    if (!sessionId) {
      console.error("usage: shoggoth elevation revoke <session-id> | --id <grant-id>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "elevation_revoke",
      payload: { session_id: sessionId },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  printElevationHelp();
  process.exitCode = 1;
}
