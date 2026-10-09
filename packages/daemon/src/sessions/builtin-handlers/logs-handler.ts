// -----------------------------------------------------------------------------
// builtin-logs — view Shoggoth daemon logs via jq filtering
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { createReadStream, promises as fsp } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { LAYOUT } from "@shoggoth/shared";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { truncateToolOutput } from "./truncate-output";

const MAX_FILTER_LENGTH = 2_000;
const MAX_DAYS = 31;
const DEFAULT_TAIL_LINES = 5_000;
const MAX_TAIL_LINES = 20_000;
/** Hard cap on raw input fed to jq (oldest bytes are dropped first). */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const JQ_TIMEOUT_MS = 15_000;
const PREFILTER_TIMEOUT_MS = 5_000;

export function register(registry: BuiltinToolRegistry): void {
  registry.register("logs", logsHandler);
}

/**
 * Structural sanity check for a jq program: length limits plus balanced
 * brackets and terminated string literals outside of quotes. Not a full
 * parser — jq does the real validation and its errors are surfaced verbatim.
 */
export function validateJqFilter(filter: string): string | undefined {
  if (filter.trim().length === 0) return "filter is required";
  if (filter.length > MAX_FILTER_LENGTH) {
    return `filter exceeds ${MAX_FILTER_LENGTH} characters`;
  }
  let depth = 0;
  let inString: '"' | "'" | undefined;
  let escaped = false;
  for (const ch of filter) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth < 0) return "filter has unbalanced brackets";
    }
  }
  if (inString) return "filter has an unterminated string literal";
  if (depth !== 0) return "filter has unbalanced brackets";
  return undefined;
}

function positiveIntArg(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

async function readGzFile(file: string): Promise<string> {
  const chunks: Buffer[] = [];
  const stream = createReadStream(file).pipe(createGunzip());
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface BinRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

function runStdio(
  bin: string,
  binArgs: string[],
  input: string,
  timeoutMs: number,
): Promise<BinRunResult> {
  return new Promise((resolve) => {
    // Minimal environment: the child's `env` builtin must not expose daemon secrets.
    const child = spawn(bin, binArgs, {
      env: {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: BinRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        stdout: "",
        stderr: "",
        exitCode: null,
        error: `${bin} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        stdout: "",
        stderr: "",
        exitCode: null,
        error: `${bin} failed to start: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ stdout, stderr, exitCode: code });
    });
    // EPIPE when the child exits early (e.g. jq compile error) — the close handler reports it.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function logsHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const filter = typeof args.filter === "string" ? args.filter : undefined;
  if (!filter) {
    return { resultJson: JSON.stringify({ error: "filter is required" }) };
  }
  const filterError = validateJqFilter(filter);
  if (filterError) {
    return { resultJson: JSON.stringify({ error: filterError }) };
  }

  const days = positiveIntArg(args.days, 1, MAX_DAYS);
  const tailLines = positiveIntArg(args.tail, DEFAULT_TAIL_LINES, MAX_TAIL_LINES);
  const compact = args.compact !== false;

  const logDir = ctx.config.logging?.file?.dir ?? LAYOUT.logDir;

  // Date window, oldest first (UTC stamps match the file sink).
  const stamps: string[] = [];
  const nowMs = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    stamps.push(new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10));
  }

  // Prefer the plain current file; fall back to the rotated archive.
  const files: string[] = [];
  for (const stamp of stamps) {
    const plain = join(logDir, `shoggoth-${stamp}.log`);
    try {
      if ((await fsp.stat(plain)).isFile()) {
        files.push(plain);
        continue;
      }
    } catch {
      /* missing */
    }
    try {
      if ((await fsp.stat(`${plain}.gz`)).isFile()) {
        files.push(`${plain}.gz`);
      }
    } catch {
      /* missing */
    }
  }

  if (files.length === 0) {
    return {
      resultJson: JSON.stringify({ error: "no log files found for the requested window", days }),
    };
  }

  // Concatenate oldest -> newest; cap total input, then keep only the tail.
  let input = "";
  let trimmedFront = false;
  for (const file of files) {
    const text = file.endsWith(".gz") ? await readGzFile(file) : await fsp.readFile(file, "utf8");
    input += text;
    if (input.length > MAX_INPUT_BYTES) {
      input = input.slice(input.length - MAX_INPUT_BYTES);
      trimmedFront = true;
    }
  }
  const allLines = input.split("\n");
  while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const start = Math.max(0, allLines.length - tailLines, trimmedFront ? 1 : 0);
  const windowed = allLines.slice(start).join("\n");

  // Pre-filter: drop any line that doesn't start with "{" — garbage or
  // partial lines (rotation races, truncated writes) would otherwise poison
  // the entire jq run. rg exit 1 = no matches (empty input), 2 = error.
  const pre = await runStdio("rg", ["--text", "--", "^\\{"], windowed, PREFILTER_TIMEOUT_MS);
  if (pre.error !== undefined) {
    return { resultJson: JSON.stringify({ error: pre.error }) };
  }
  if (pre.exitCode === 2) {
    return { resultJson: JSON.stringify({ error: pre.stderr.trim() || "rg error" }) };
  }

  const jqArgs = compact ? ["-c", filter, "-"] : [filter, "-"];
  const run = await runStdio("jq", jqArgs, pre.stdout, JQ_TIMEOUT_MS);
  if (run.error !== undefined) {
    return { resultJson: JSON.stringify({ error: run.error }) };
  }
  if (run.exitCode !== 0) {
    return {
      resultJson: JSON.stringify({
        error: run.stderr.trim() || `jq exited with code ${run.exitCode}`,
      }),
    };
  }

  return {
    resultJson: JSON.stringify({ output: truncateToolOutput(run.stdout) }),
  };
}
