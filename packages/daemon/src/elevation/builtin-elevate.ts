import { execFileSync } from "node:child_process";
import type { BuiltinToolContext } from "../sessions/builtin-tool-registry";
import { createElevationStore } from "./elevation-store";
import { getLogger } from "../logging";

const log = getLogger("builtin-elevate");

const MAX_OUTPUT = 1024 * 256; // 256KB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export interface ElevateArgs {
  argv: string[];
  workdir?: string;
  timeout?: number;
}

export function handleElevate(
  args: ElevateArgs,
  ctx: BuiltinToolContext,
): { resultJson: string } {
  const store = createElevationStore(ctx.db);

  if (!store.isActive(ctx.sessionId)) {
    return {
      resultJson: JSON.stringify({
        error:
          "No active elevation grant. Ask the operator to grant elevation.",
      }),
    };
  }

  if (!args.argv || args.argv.length === 0) {
    return { resultJson: JSON.stringify({ error: "argv is required" }) };
  }

  const grant = store.getStatus(ctx.sessionId);
  const grantId = grant.grant?.id ?? "unknown";
  const [cmd, ...cmdArgs] = args.argv;
  const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  log.info("elevated exec", {
    sessionId: ctx.sessionId,
    grantId,
    argv: args.argv,
    workdir: args.workdir,
  });

  try {
    const output = execFileSync(cmd!, cmdArgs, {
      cwd: args.workdir,
      timeout,
      maxBuffer: MAX_OUTPUT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { resultJson: JSON.stringify({ exitCode: 0, output }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    const exitCode = e.status ?? 1;
    const output = (e.stdout ?? "") + (e.stderr ?? "");
    return {
      resultJson: JSON.stringify({
        exitCode,
        output: output.slice(0, MAX_OUTPUT),
      }),
    };
  }
}
