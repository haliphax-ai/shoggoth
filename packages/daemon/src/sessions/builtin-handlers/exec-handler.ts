// ---------------------------------------------------------------------------
// exec & poll handlers
// ---------------------------------------------------------------------------

import { toolExec, toolExecExtended, toolPoll } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { truncateToolOutput } from "./truncate-output";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("exec", execHandler);
  registry.register("poll", pollHandler);
}

/** Effective root for exec: workingDirectory if set, else workspacePath. */
function execCwd(ctx: BuiltinToolContext): string | undefined {
  return ctx.workingDirectory ?? undefined;
}

async function execHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const argv = args.argv as unknown;
  if (!Array.isArray(argv) || argv.some((x) => typeof x !== "string")) {
    return {
      resultJson: JSON.stringify({ error: "exec requires string argv[]" }),
    };
  }
  try {
    return await execHandlerInner(argv as string[], args, ctx);
  } catch (e) {
    return { resultJson: JSON.stringify({ error: String(e) }) };
  }
}

async function execHandlerInner(
  argv: string[],
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  // Check if any extended params are present
  const hasExtended =
    args.timeout !== undefined ||
    args.stdin !== undefined ||
    args.workdir !== undefined ||
    args.env !== undefined ||
    args.splitStreams !== undefined ||
    args.maxOutput !== undefined ||
    args.truncation !== undefined ||
    args.background !== undefined ||
    args.yieldMs !== undefined ||
    args.stdoutFile !== undefined ||
    args.stderrFile !== undefined ||
    args.outputFile !== undefined;
  if (hasExtended) {
    // Convert argv to a shell command string for toolExecExtended
    const command = (argv as string[])
      .map((a) => (/[^a-zA-Z0-9_\-./=:]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a))
      .join(" ");
    const r = await toolExecExtended(
      ctx.workspacePath,
      {
        command,
        timeout: typeof args.timeout === "number" ? Math.ceil(args.timeout / 1000) : undefined,
        stdin: typeof args.stdin === "string" ? args.stdin : undefined,
        workdir:
          typeof args.workdir === "string" ? resolveUserPath(ctx, args.workdir) : execCwd(ctx),
        env:
          args.env && typeof args.env === "object"
            ? (args.env as Record<string, string>)
            : undefined,
        splitStreams: typeof args.splitStreams === "boolean" ? args.splitStreams : undefined,
        maxOutput: typeof args.maxOutput === "number" ? args.maxOutput : undefined,
        truncation:
          typeof args.truncation === "string"
            ? (args.truncation as "head" | "tail" | "both")
            : undefined,
        background: typeof args.background === "boolean" ? args.background : undefined,
        yieldMs: typeof args.yieldMs === "number" ? args.yieldMs : undefined,
        stdoutFile: typeof args.stdoutFile === "string" ? args.stdoutFile : undefined,
        stderrFile: typeof args.stderrFile === "string" ? args.stderrFile : undefined,
        outputFile: typeof args.outputFile === "string" ? args.outputFile : undefined,
      },
      ctx.creds,
    );
    if (r.kind === "background") {
      return {
        resultJson: JSON.stringify({
          status: "running",
          sessionId: r.sessionId,
          pid: r.pid,
          yielded: r.yielded ?? false,
          partialOutput: r.partialOutput,
        }),
      };
    }
    // File output — return paths, not content
    if (r.outputFile) {
      return {
        resultJson: JSON.stringify({
          exitCode: r.exitCode,
          outputFile: r.outputFile,
        }),
      };
    }
    if (r.stdoutFile || r.stderrFile) {
      const result: Record<string, unknown> = { exitCode: r.exitCode };
      if (r.stdoutFile) result.stdoutFile = r.stdoutFile;
      else if (r.stdout !== undefined) result.stdout = truncateToolOutput(r.stdout);
      if (r.stderrFile) result.stderrFile = r.stderrFile;
      else if (r.stderr !== undefined) result.stderr = truncateToolOutput(r.stderr);
      if (r.stdoutTruncated) result.stdoutTruncated = true;
      if (r.stderrTruncated) result.stderrTruncated = true;
      return { resultJson: JSON.stringify(result) };
    }
    // Normal foreground completion — check if split streams were used
    if (r.stdout !== undefined || r.stderr !== undefined) {
      return {
        resultJson: JSON.stringify({
          exitCode: r.exitCode,
          stdout: r.stdout != null ? truncateToolOutput(r.stdout) : r.stdout,
          stderr: r.stderr != null ? truncateToolOutput(r.stderr) : r.stderr,
          stdoutTruncated: r.stdoutTruncated,
          stderrTruncated: r.stderrTruncated,
        }),
      };
    }
    return {
      resultJson: JSON.stringify({
        exitCode: r.exitCode,
        output: r.output != null ? truncateToolOutput(r.output) : r.output,
        truncated: r.truncated,
      }),
    };
  }
  const r = await toolExec(ctx.workspacePath, argv as string[], ctx.creds, execCwd(ctx));
  return {
    resultJson: JSON.stringify({
      exitCode: r.exitCode,
      stdout: truncateToolOutput(r.stdout),
      stderr: truncateToolOutput(r.stderr),
    }),
  };
}

async function pollHandler(
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const pid = typeof args.pid === "number" ? args.pid : undefined;
  if (pid === undefined) {
    return {
      resultJson: JSON.stringify({ error: "poll requires a numeric pid" }),
    };
  }
  const r = await toolPoll({
    pid,
    timeout: typeof args.timeout === "number" ? Math.ceil(args.timeout / 1000) : undefined,
    streams: typeof args.streams === "boolean" ? args.streams : undefined,
    tail: typeof args.tail === "number" ? args.tail : undefined,
    since: typeof args.since === "number" ? args.since : undefined,
  });
  const raw = JSON.stringify(r);
  return { resultJson: truncateToolOutput(raw) };
}
