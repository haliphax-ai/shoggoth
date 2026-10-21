// ---------------------------------------------------------------------------
// exec & poll handlers
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { toolExec, toolExecExtended, toolPoll } from "@shoggoth/os-exec";

function osExec(ctx: BuiltinToolContext) {
  return ctx.osExec ?? { toolExec, toolExecExtended, toolPoll };
}
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { truncateToolOutput } from "./truncate-output";
import { resolveVaultEnv } from "../../mcp/vault-env-resolve";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import { resolveExecMaxYieldMs } from "../../config/effective-runtime";
import { getExecNotifyScheduler, type ExecNotifyOptions } from "../../exec/exec-notify-scheduler";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("exec", execHandler);
  registry.register("poll", pollHandler);
}

/** Effective root for exec: workingDirectory if set, else workspacePath. */
function execCwd(ctx: BuiltinToolContext): string | undefined {
  return ctx.workingDirectory ?? undefined;
}

/**
 * Clamp the requested yield window to the configured maximum
 * (`runtime.execMaxYieldMs`, default 30 s). The requested window is honored
 * up to the cap — never silently dropped (issue #478).
 */
function resolveYieldMs(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): number | undefined {
  if (typeof args.yieldMs !== "number") return undefined;
  return Math.min(args.yieldMs, resolveExecMaxYieldMs(ctx.config));
}

/**
 * Track a backgrounded exec for completion notification (the `notify` flag,
 * default true). The handle delivers an OOB turn to the calling session when
 * the subprocess finishes, and its live count drives the status bar section.
 */
function registerExecNotify(
  ctx: BuiltinToolContext,
  input: { execSessionId: string; pid: number; command: string; options: ExecNotifyOptions },
): void {
  const scheduler = getExecNotifyScheduler();
  if (!scheduler) {
    // No scheduler (e.g. bare test harness): the call simply goes untracked;
    // polling still works.
    return;
  }
  scheduler.register(
    ctx.db,
    {
      id: randomUUID(),
      sessionId: ctx.sessionId,
      execSessionId: input.execSessionId,
      pid: input.pid,
      command: input.command,
      options: input.options,
    },
    (execSessionId) => ctx.getProcessManager()?.get(execSessionId),
  );
  ctx.onNotifiesChanged?.(scheduler.countForSession(ctx.db, ctx.sessionId));
}

/** Resolve $vault: references in exec env vars, if vault is available. */
async function resolveExecEnv(
  env: unknown,
  ctx: BuiltinToolContext,
): Promise<Record<string, string> | undefined> {
  if (!env || typeof env !== "object") return undefined;
  const raw = env as Record<string, string>;
  if (!ctx.vault) return raw;
  const agentId = parseAgentSessionUrn(ctx.sessionId)?.agentId;
  return resolveVaultEnv(raw, ctx.vault, agentId);
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
    const r = await osExec(ctx).toolExecExtended(
      ctx.workspacePath,
      {
        command,
        timeout: typeof args.timeout === "number" ? Math.ceil(args.timeout / 1000) : undefined,
        stdin: typeof args.stdin === "string" ? args.stdin : undefined,
        workdir:
          typeof args.workdir === "string" ? resolveUserPath(ctx, args.workdir) : execCwd(ctx),
        env: await resolveExecEnv(args.env, ctx),
        splitStreams: typeof args.splitStreams === "boolean" ? args.splitStreams : undefined,
        maxOutput: typeof args.maxOutput === "number" ? args.maxOutput : undefined,
        truncation:
          typeof args.truncation === "string"
            ? (args.truncation as "head" | "tail" | "both")
            : undefined,
        background: typeof args.background === "boolean" ? args.background : undefined,
        yieldMs: resolveYieldMs(args, ctx),
        stdoutFile: typeof args.stdoutFile === "string" ? args.stdoutFile : undefined,
        stderrFile: typeof args.stderrFile === "string" ? args.stderrFile : undefined,
        outputFile: typeof args.outputFile === "string" ? args.outputFile : undefined,
      },
      ctx.creds,
    );
    if (r.kind === "background") {
      const notify = typeof args.notify === "boolean" ? args.notify : true;
      const bgResult: Record<string, unknown> = {
        status: "running",
        sessionId: r.sessionId,
        pid: r.pid,
        yielded: r.yielded ?? false,
        partialOutput: r.partialOutput,
        stdoutFile: r.stdoutFile,
        stderrFile: r.stderrFile,
        outputFile: r.outputFile,
      };
      if (notify) {
        registerExecNotify(ctx, {
          execSessionId: r.sessionId,
          pid: r.pid,
          command,
          options: {
            splitStreams: typeof args.splitStreams === "boolean" ? args.splitStreams : undefined,
            maxOutput: typeof args.maxOutput === "number" ? args.maxOutput : undefined,
            truncation:
              typeof args.truncation === "string"
                ? (args.truncation as "head" | "tail" | "both")
                : undefined,
            stdoutFile: typeof args.stdoutFile === "string" ? args.stdoutFile : undefined,
            stderrFile: typeof args.stderrFile === "string" ? args.stderrFile : undefined,
            outputFile: typeof args.outputFile === "string" ? args.outputFile : undefined,
          },
        });
        bgResult.notify = true;
      }
      return { resultJson: JSON.stringify(bgResult) };
    }
    // File output — return paths, not content
    if (r.outputFile) {
      return {
        resultJson: JSON.stringify({
          exitCode: r.exitCode,
          outputFile: r.outputFile,
          ...(r.fileOutputTruncated ? { fileOutputTruncated: true } : {}),
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
      if (r.fileOutputTruncated) result.fileOutputTruncated = true;
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
  const r = await osExec(ctx).toolExec(
    ctx.workspacePath,
    argv as string[],
    ctx.creds,
    execCwd(ctx),
  );
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
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const pid = typeof args.pid === "number" ? args.pid : undefined;
  if (pid === undefined) {
    return {
      resultJson: JSON.stringify({ error: "poll requires a numeric pid" }),
    };
  }
  const r = await osExec(ctx).toolPoll({
    pid,
    timeout: typeof args.timeout === "number" ? Math.ceil(args.timeout / 1000) : undefined,
    streams: typeof args.streams === "boolean" ? args.streams : undefined,
    tail: typeof args.tail === "number" ? args.tail : undefined,
    since: typeof args.since === "number" ? args.since : undefined,
  });
  const raw = JSON.stringify(r);
  return { resultJson: truncateToolOutput(raw) };
}
