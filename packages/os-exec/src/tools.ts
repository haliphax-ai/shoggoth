import { existsSync, realpathSync, globSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  runAsUser,
  spawnAsUser,
  readHandleOutput,
  type RunAsUserResult,
  type BackgroundHandle,
} from "./subprocess";
import { resolvePathForRead, resolvePathForWrite } from "./workspace-path";
import type { ProcessManager, ManagedProcess, ProcessSpec } from "@shoggoth/procman";

export interface AgentCredentials {
  uid: number;
  gid: number;
}

// ---------------------------------------------------------------------------
// Extended read types
// ---------------------------------------------------------------------------

/** Options for the extended read tool. All fields are optional for backward compat. */
export interface ReadExtendedOptions {
  /** Single file path (mutually exclusive with `paths`). */
  path?: string;
  /** Multiple file paths or glob patterns (mutually exclusive with `path`). */
  paths?: string[];
  /** Safety cap on total files returned when using `paths`. Default 20. */
  maxFiles?: number;
  /** First line to include, 1-indexed inclusive. Mutually exclusive with `offset`. */
  fromLine?: number;
  /** Last line to include, 1-indexed inclusive. Mutually exclusive with `limit`. `null`/`undefined` means EOF. */
  toLine?: number;
  /** Starting line (1-indexed). Existing parameter — mutually exclusive with `fromLine`. */
  offset?: number;
  /** Max number of lines to read. Existing parameter — mutually exclusive with `toLine`. */
  limit?: number;
  /** When true, return metadata only — no file content. */
  stat?: boolean;
}

/** Metadata returned for a single file in stat mode. */
export interface FileStat {
  path: string;
  size: number;
  sizeHuman: string;
  mtime: string;
  type: "file" | "directory" | "symlink" | "other";
  permissions: string;
  lines?: number;
  /** True when the path is a symlink. */
  symlink?: boolean;
  /** Symlink target path (only present when `symlink` is true). */
  target?: string;
  /** Error string when stat fails for this path (e.g. permission denied). */
  error?: string;
}

/** Result of a single-file read (backward-compatible string). */
export interface ReadSingleResult {
  kind: "single";
  content: string;
}

/** Result of a multi-file read — keyed by relative path. */
export interface ReadMultiResult {
  kind: "multi";
  files: Record<string, string>;
  /** Paths that were truncated or skipped. */
  notices?: string[];
}

/** Result of a single-file stat. */
export interface StatSingleResult {
  kind: "stat-single";
  stat: FileStat;
}

/** Result of a multi-file stat. */
export interface StatMultiResult {
  kind: "stat-multi";
  stats: FileStat[];
}

export type ReadExtendedResult =
  | ReadSingleResult
  | ReadMultiResult
  | StatSingleResult
  | StatMultiResult;

// ---------------------------------------------------------------------------
// Extended write types
// ---------------------------------------------------------------------------

/** Options for the extended write tool. All fields except `path` and `content` are optional. */
export interface WriteExtendedOptions {
  /** File path (workspace-relative). */
  path: string;
  /** Content to write, append, or insert. */
  content: string;
  /** When true, append content to the end of the file instead of overwriting. */
  append?: boolean;
  /** 1-indexed line where a replacement begins. Requires the file to exist. */
  startLine?: number;
  /** 1-indexed line where a replacement ends (inclusive). Defaults to startLine if omitted. */
  endLine?: number;
  /** 1-indexed line after which content is inserted. 0 = before first line. Requires the file to exist. */
  insertAfter?: number;
  /** Automatically create parent directories if they don't exist. Default true. */
  mkdirp?: boolean;
}

/** Result metadata returned by toolWriteExtended. */
export interface WriteExtendedResult {
  /** Absolute path that was written. */
  path: string;
  /** Number of bytes written (full file size for overwrite/line-range; appended bytes for append). */
  bytesWritten: number;
  /** True if parent directories were created by mkdirp. */
  dirCreated?: boolean;
}

const ENV_READ = "SHOGGOTH_TOOL_READ_PATH";
const ENV_WRITE = "SHOGGOTH_TOOL_WRITE_PATH";

function nodeReadScript(): string {
  return `require("fs").writeFileSync(1, require("fs").readFileSync(process.env.${ENV_READ}, "utf8"));`;
}

function nodeWriteScript(): string {
  return `require("fs").writeFileSync(process.env.${ENV_WRITE}, require("fs").readFileSync(0, "utf8"));`;
}

/**
 * Read a workspace-relative path as the agent UID/GID (kernel DAC applies to the child).
 */
export async function toolRead(
  workspaceRoot: string,
  userPath: string,
  creds: AgentCredentials,
): Promise<string> {
  const abs = resolvePathForRead(workspaceRoot, userPath);
  const cwd = realpathSync(workspaceRoot);
  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", nodeReadScript()],
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    env: { [ENV_READ]: abs },
  });
  if (r.exitCode !== 0) {
    throw new Error(`toolRead failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }
  return r.stdout;
}

/**
 * Write content to a workspace-relative path as the agent UID/GID.
 */
export async function toolWrite(
  workspaceRoot: string,
  userPath: string,
  content: string,
  creds: AgentCredentials,
): Promise<void> {
  const abs = resolvePathForWrite(workspaceRoot, userPath);
  const cwd = realpathSync(workspaceRoot);
  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", nodeWriteScript()],
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    stdin: content,
    env: { [ENV_WRITE]: abs },
  });
  if (r.exitCode !== 0) {
    throw new Error(`toolWrite failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }
}

// ---------------------------------------------------------------------------
// Extended write helpers
// ---------------------------------------------------------------------------

const ENV_WRITE_MODE = "SHOGGOTH_TOOL_WRITE_MODE";
const ENV_WRITE_START = "SHOGGOTH_TOOL_WRITE_START";
const ENV_WRITE_END = "SHOGGOTH_TOOL_WRITE_END";
const ENV_WRITE_AFTER = "SHOGGOTH_TOOL_WRITE_AFTER";
const ENV_WRITE_MKDIRP = "SHOGGOTH_TOOL_WRITE_MKDIRP";

/**
 * Subprocess script for the extended write tool.
 *
 * Reads content from stdin, then performs the operation indicated by env vars:
 *   MODE=overwrite  — write stdin to file (with optional mkdirp)
 *   MODE=append     — append stdin to file (with optional mkdirp)
 *   MODE=replace    — replace lines START..END with stdin content
 *   MODE=insert     — insert stdin content after line AFTER
 *
 * Outputs JSON to stdout: { bytesWritten, dirCreated }
 */
function nodeWriteExtendedScript(): string {
  return [
    `const fs = require("fs");`,
    `const path = require("path");`,
    `const filePath = process.env.${ENV_WRITE};`,
    `const mode = process.env.${ENV_WRITE_MODE} || "overwrite";`,
    `const mkdirp = process.env.${ENV_WRITE_MKDIRP} !== "0";`,
    `const content = fs.readFileSync(0, "utf8");`,
    `let bytesWritten = 0;`,
    `let dirCreated = false;`,

    // Helper: ensure parent directories exist
    `function ensureDir(fp) {`,
    `  const dir = path.dirname(fp);`,
    `  if (!fs.existsSync(dir)) {`,
    `    fs.mkdirSync(dir, { recursive: true });`,
    `    dirCreated = true;`,
    `  }`,
    `}`,

    `try {`,

    // --- Overwrite mode ---
    `  if (mode === "overwrite") {`,
    `    if (mkdirp) ensureDir(filePath);`,
    `    fs.writeFileSync(filePath, content);`,
    `    bytesWritten = Buffer.byteLength(content, "utf8");`,

    // --- Append mode ---
    `  } else if (mode === "append") {`,
    `    if (mkdirp) ensureDir(filePath);`,
    `    fs.appendFileSync(filePath, content);`,
    `    bytesWritten = Buffer.byteLength(content, "utf8");`,

    // --- Line-range replace mode ---
    `  } else if (mode === "replace") {`,
    `    const startLine = parseInt(process.env.${ENV_WRITE_START}, 10);`,
    `    const endLine = parseInt(process.env.${ENV_WRITE_END}, 10);`,
    `    if (!fs.existsSync(filePath)) {`,
    `      process.stderr.write("file does not exist: " + filePath);`,
    `      process.exit(1);`,
    `    }`,
    `    const existing = fs.readFileSync(filePath, "utf8");`,
    // Binary check: NUL in first 8KB
    `    if (existing.slice(0, 8192).includes("\\0")) {`,
    `      process.stderr.write("cannot perform line-range operation on binary file");`,
    `      process.exit(1);`,
    `    }`,
    `    const lines = existing.split("\\n");`,
    `    const totalLines = lines.length;`,
    `    if (startLine < 1 || startLine > totalLines) {`,
    `      process.stderr.write("startLine " + startLine + " is out of range (file has " + totalLines + " lines)");`,
    `      process.exit(1);`,
    `    }`,
    `    if (endLine < startLine || endLine > totalLines) {`,
    `      process.stderr.write("endLine " + endLine + " is out of range (file has " + totalLines + " lines, startLine is " + startLine + ")");`,
    `      process.exit(1);`,
    `    }`,
    // Replace lines[startLine-1..endLine-1] with content lines.
    // If content is empty, this deletes the range.
    `    const newLines = content.length === 0 ? [] : content.split("\\n");`,
    `    lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);`,
    `    const result = lines.join("\\n");`,
    `    fs.writeFileSync(filePath, result);`,
    `    bytesWritten = Buffer.byteLength(result, "utf8");`,

    // --- Insert-after mode ---
    `  } else if (mode === "insert") {`,
    `    const afterLine = parseInt(process.env.${ENV_WRITE_AFTER}, 10);`,
    `    if (!fs.existsSync(filePath)) {`,
    `      process.stderr.write("file does not exist: " + filePath);`,
    `      process.exit(1);`,
    `    }`,
    `    const existing = fs.readFileSync(filePath, "utf8");`,
    // Binary check
    `    if (existing.slice(0, 8192).includes("\\0")) {`,
    `      process.stderr.write("cannot perform line-range operation on binary file");`,
    `      process.exit(1);`,
    `    }`,
    `    const lines = existing.split("\\n");`,
    `    const totalLines = lines.length;`,
    `    if (afterLine < 0 || afterLine > totalLines) {`,
    `      process.stderr.write("insertAfter " + afterLine + " is out of range (file has " + totalLines + " lines)");`,
    `      process.exit(1);`,
    `    }`,
    `    const newLines = content.split("\\n");`,
    `    lines.splice(afterLine, 0, ...newLines);`,
    `    const result = lines.join("\\n");`,
    `    fs.writeFileSync(filePath, result);`,
    `    bytesWritten = Buffer.byteLength(result, "utf8");`,

    `  } else {`,
    `    process.stderr.write("unknown write mode: " + mode);`,
    `    process.exit(1);`,
    `  }`,

    `  process.stdout.write(JSON.stringify({ bytesWritten, dirCreated }));`,
    `} catch (e) {`,
    `  process.stderr.write(e.message);`,
    `  process.exit(1);`,
    `}`,
  ].join(" ");
}

/**
 * Validate WriteExtendedOptions, throwing on invalid combinations.
 */
function validateWriteOptions(opts: WriteExtendedOptions): void {
  if (!opts.path) {
    throw new Error("`path` is required.");
  }
  if (opts.content === undefined || opts.content === null) {
    throw new Error("`content` is required.");
  }

  const hasAppend = opts.append === true;
  const hasLineRange = opts.startLine !== undefined || opts.endLine !== undefined;
  const hasInsert = opts.insertAfter !== undefined;

  // Mutual exclusivity: append, startLine/endLine, insertAfter
  const modeCount = [hasAppend, hasLineRange, hasInsert].filter(Boolean).length;
  if (modeCount > 1) {
    throw new Error(
      "Only one write mode is allowed at a time: `append`, `startLine`/`endLine`, or `insertAfter`.",
    );
  }

  // endLine without startLine
  if (opts.endLine !== undefined && opts.startLine === undefined) {
    throw new Error("`endLine` requires `startLine`.");
  }

  // startLine validation
  if (opts.startLine !== undefined && opts.startLine < 1) {
    throw new Error("`startLine` must be >= 1.");
  }

  // endLine validation
  if (opts.endLine !== undefined && opts.endLine < 1) {
    throw new Error("`endLine` must be >= 1.");
  }

  // endLine >= startLine
  if (opts.startLine !== undefined && opts.endLine !== undefined && opts.endLine < opts.startLine) {
    throw new Error(
      `\`endLine\` (${opts.endLine}) must be >= \`startLine\` (${opts.startLine}).`,
    );
  }

  // insertAfter validation
  if (opts.insertAfter !== undefined && opts.insertAfter < 0) {
    throw new Error("`insertAfter` must be >= 0.");
  }
}

/**
 * Extended write tool supporting append, line-range replace/insert, and auto mkdir -p.
 *
 * All new parameters are optional — when called with just `path` and `content`,
 * behavior is identical to the original `toolWrite` (plus auto mkdirp).
 */
export async function toolWriteExtended(
  workspaceRoot: string,
  opts: WriteExtendedOptions,
  creds: AgentCredentials,
): Promise<WriteExtendedResult> {
  validateWriteOptions(opts);

  const hasLineRange = opts.startLine !== undefined;
  const hasInsert = opts.insertAfter !== undefined;
  const isLineOp = hasLineRange || hasInsert;

  // Line-range operations require the file to exist — use resolvePathForRead to verify.
  // Overwrite/append may create the file — use resolvePathForWrite.
  const abs = isLineOp
    ? resolvePathForRead(workspaceRoot, opts.path)
    : resolvePathForWrite(workspaceRoot, opts.path);

  const cwd = realpathSync(workspaceRoot);

  // Determine the write mode for the subprocess
  let mode: string;
  if (opts.append) {
    mode = "append";
  } else if (hasLineRange) {
    mode = "replace";
  } else if (hasInsert) {
    mode = "insert";
  } else {
    mode = "overwrite";
  }

  // Build env vars for the subprocess
  const env: NodeJS.ProcessEnv = {
    [ENV_WRITE]: abs,
    [ENV_WRITE_MODE]: mode,
    [ENV_WRITE_MKDIRP]: (opts.mkdirp ?? true) ? "1" : "0",
  };

  if (hasLineRange) {
    env[ENV_WRITE_START] = String(opts.startLine);
    env[ENV_WRITE_END] = String(opts.endLine ?? opts.startLine);
  }

  if (hasInsert) {
    env[ENV_WRITE_AFTER] = String(opts.insertAfter);
  }

  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", nodeWriteExtendedScript()],
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    stdin: opts.content,
    env,
  });

  if (r.exitCode !== 0) {
    throw new Error(`toolWriteExtended failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  // Parse result metadata from subprocess stdout
  try {
    const result = JSON.parse(r.stdout) as { bytesWritten: number; dirCreated: boolean };
    return {
      path: abs,
      bytesWritten: result.bytesWritten,
      dirCreated: result.dirCreated || undefined,
    };
  } catch {
    // Fallback if JSON parsing fails — operation still succeeded
    return { path: abs, bytesWritten: Buffer.byteLength(opts.content, "utf8") };
  }
}

/**
 * XDG base directories scoped to the agent workspace so tools like `uv` get writable
 * config/cache/data paths without touching daemon-owned trees.
 */
function xdgEnvForWorkspace(workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    HOME: workspaceRoot,
    XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
    XDG_DATA_HOME: join(workspaceRoot, ".local", "share"),
    XDG_CACHE_HOME: join(workspaceRoot, ".cache"),
    XDG_STATE_HOME: join(workspaceRoot, ".local", "state"),
  };
}

/**
 * Execute argv[0] with remaining args; working directory is the real workspace root.
 */
export async function toolExec(
  workspaceRoot: string,
  argv: string[],
  creds: AgentCredentials,
): Promise<RunAsUserResult> {
  if (argv.length === 0) {
    throw new Error("toolExec requires a non-empty argv");
  }
  const cwd = realpathSync(workspaceRoot);
  const file = argv[0]!;
  const args = argv.slice(1);
  return runAsUser({
    file,
    args,
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    env: xdgEnvForWorkspace(cwd),
  });
}

// ---------------------------------------------------------------------------
// Extended read helpers
// ---------------------------------------------------------------------------

/** Max file size (bytes) for which we count lines in stat mode. */
const STAT_LINE_COUNT_LIMIT = 10 * 1024 * 1024; // 10 MB

/** Per-file content cap (bytes) for multi-file reads. */
const PER_FILE_MAX_BYTES = 50 * 1024; // 50 KB

/** Per-file line cap for multi-file reads. */
const PER_FILE_MAX_LINES = 2000;

/** Format byte count as human-readable string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Convert octal mode to rwx permission string (e.g. "rw-r--r--"). */
function formatPermissions(mode: number): string {
  const perms = mode & 0o777;
  const chars = "rwx";
  let result = "";
  for (let i = 8; i >= 0; i--) {
    result += perms & (1 << i) ? chars[2 - (i % 3)] : "-";
  }
  return result;
}

/**
 * Subprocess script that outputs JSON stat info for the path in SHOGGOTH_TOOL_STAT_PATH.
 * Runs as the agent UID/GID so kernel DAC applies.
 */
function nodeStatScript(): string {
  return [
    `const fs = require("fs");`,
    `const p = process.env.SHOGGOTH_TOOL_STAT_PATH;`,
    `try {`,
    `  const lst = fs.lstatSync(p);`,
    `  const isSymlink = lst.isSymbolicLink();`,
    `  const st = isSymlink ? fs.statSync(p) : lst;`,
    `  let type = "other";`,
    `  if (st.isFile()) type = "file";`,
    `  else if (st.isDirectory()) type = "directory";`,
    `  const out = { size: st.size, mtime: st.mtime.toISOString(), mode: st.mode, type, isSymlink };`,
    `  if (isSymlink) out.target = fs.readlinkSync(p);`,
    // Count lines for small regular files
    `  if (type === "file" && st.size <= ${STAT_LINE_COUNT_LIMIT}) {`,
    `    try { out.lines = fs.readFileSync(p, "utf8").split("\\n").length - 1; } catch {}`,
    `  }`,
    `  process.stdout.write(JSON.stringify(out));`,
    `} catch (e) {`,
    `  process.stdout.write(JSON.stringify({ error: e.message }));`,
    `}`,
  ].join(" ");
}

/**
 * Stat a single workspace-relative path as the agent UID/GID.
 * Returns raw stat JSON from the subprocess.
 */
async function toolStatRaw(
  workspaceRoot: string,
  absPath: string,
  creds: AgentCredentials,
): Promise<Record<string, unknown>> {
  const cwd = realpathSync(workspaceRoot);
  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", nodeStatScript()],
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    env: { SHOGGOTH_TOOL_STAT_PATH: absPath },
  });
  if (r.exitCode !== 0) {
    return { error: r.stderr.trim() || `exit ${r.exitCode}` };
  }
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return { error: `unexpected stat output: ${r.stdout.slice(0, 200)}` };
  }
}

/** Build a FileStat from raw subprocess output. */
function buildFileStat(relPath: string, raw: Record<string, unknown>): FileStat {
  if (raw.error) {
    return { path: relPath, size: 0, sizeHuman: "0 B", mtime: "", type: "other", permissions: "---------", error: String(raw.error) };
  }
  const size = raw.size as number;
  const result: FileStat = {
    path: relPath,
    size,
    sizeHuman: formatSize(size),
    mtime: raw.mtime as string,
    type: raw.type as FileStat["type"],
    permissions: formatPermissions(raw.mode as number),
  };
  if (raw.lines !== undefined) result.lines = raw.lines as number;
  if (raw.isSymlink) {
    result.symlink = true;
    result.target = raw.target as string;
  }
  return result;
}

/**
 * Resolve an array of paths/globs to concrete workspace-relative paths.
 * Globs are expanded against the real workspace root. Each result is validated
 * through resolvePathForRead. Returns paths relative to workspace root.
 */
function resolvePathList(
  workspaceRoot: string,
  patterns: string[],
  maxFiles: number,
): { relativePaths: string[]; truncated: boolean } {
  const rootReal = realpathSync(workspaceRoot);
  const seen = new Set<string>();
  const results: string[] = [];

  for (const pattern of patterns) {
    // Check if the pattern contains glob characters
    const isGlob = /[*?{}\[\]]/.test(pattern);
    if (isGlob) {
      const matches = globSync(pattern, { cwd: rootReal });
      const sorted = (matches as string[]).sort();
      for (const match of sorted) {
        if (results.length >= maxFiles) break;
        try {
          // Validate the resolved path stays inside workspace
          const abs = resolvePathForRead(workspaceRoot, match);
          if (!seen.has(abs)) {
            seen.add(abs);
            results.push(relative(rootReal, abs));
          }
        } catch {
          // Skip paths that fail validation (escapes, broken symlinks, etc.)
        }
      }
    } else {
      if (results.length >= maxFiles) break;
      try {
        const abs = resolvePathForRead(workspaceRoot, pattern);
        if (!seen.has(abs)) {
          seen.add(abs);
          results.push(relative(rootReal, abs));
        }
      } catch {
        // For explicit paths, we still add them so the error surfaces per-file
        if (!seen.has(pattern)) {
          seen.add(pattern);
          results.push(pattern);
        }
      }
    }
  }

  const truncated = results.length >= maxFiles;
  return { relativePaths: results.slice(0, maxFiles), truncated };
}

/**
 * Apply line-range slicing to file content.
 * Supports either fromLine/toLine or offset/limit semantics.
 */
function sliceLines(
  content: string,
  opts: Pick<ReadExtendedOptions, "fromLine" | "toLine" | "offset" | "limit">,
): string {
  const lines = content.split("\n");

  if (opts.fromLine !== undefined || opts.toLine !== undefined) {
    const from = opts.fromLine ?? 1;
    const to = opts.toLine ?? lines.length;
    // fromLine and toLine are 1-indexed inclusive
    return lines.slice(from - 1, to).join("\n");
  }

  if (opts.offset !== undefined || opts.limit !== undefined) {
    const off = opts.offset ?? 1;
    const lim = opts.limit ?? lines.length;
    return lines.slice(off - 1, off - 1 + lim).join("\n");
  }

  return content;
}

/**
 * Truncate content to per-file limits (line count and byte size).
 * Returns { content, truncated }.
 */
function truncateContent(content: string): { content: string; truncated: boolean } {
  const lines = content.split("\n");
  let truncated = false;

  if (lines.length > PER_FILE_MAX_LINES) {
    truncated = true;
    content = lines.slice(0, PER_FILE_MAX_LINES).join("\n");
  }

  if (Buffer.byteLength(content, "utf8") > PER_FILE_MAX_BYTES) {
    truncated = true;
    // Trim to byte limit by slicing (rough but safe)
    const buf = Buffer.from(content, "utf8");
    content = buf.subarray(0, PER_FILE_MAX_BYTES).toString("utf8");
  }

  return { content, truncated };
}

/** Detect binary content by checking for NUL bytes in the first 8KB. */
function isBinaryContent(content: string): boolean {
  const sample = content.slice(0, 8192);
  return sample.includes("\0");
}

/**
 * Validate ReadExtendedOptions, throwing on invalid combinations.
 */
function validateReadOptions(opts: ReadExtendedOptions): void {
  // path vs paths mutual exclusivity
  if (opts.path && opts.paths?.length) {
    throw new Error("Cannot specify both `path` and `paths` — use one or the other.");
  }
  if (!opts.path && (!opts.paths || opts.paths.length === 0)) {
    throw new Error("Either `path` or `paths` must be provided.");
  }

  // fromLine/toLine vs offset/limit mutual exclusivity
  const hasFromTo = opts.fromLine !== undefined || opts.toLine !== undefined;
  const hasOffsetLimit = opts.offset !== undefined || opts.limit !== undefined;
  if (hasFromTo && hasOffsetLimit) {
    throw new Error("Cannot combine `fromLine`/`toLine` with `offset`/`limit` — use one pair or the other.");
  }

  // fromLine > toLine validation
  if (opts.fromLine !== undefined && opts.toLine !== undefined && opts.fromLine > opts.toLine) {
    throw new Error(`\`fromLine\` (${opts.fromLine}) must be <= \`toLine\` (${opts.toLine}).`);
  }

  // Negative values
  if (opts.fromLine !== undefined && opts.fromLine < 1) {
    throw new Error("`fromLine` must be >= 1.");
  }
  if (opts.toLine !== undefined && opts.toLine < 1) {
    throw new Error("`toLine` must be >= 1.");
  }
}

/**
 * Extended read tool supporting line ranges, glob/multi-path input, and stat-only mode.
 *
 * All new parameters are optional — when called with just `path`, behavior is identical
 * to the original `toolRead`.
 */
export async function toolReadExtended(
  workspaceRoot: string,
  opts: ReadExtendedOptions,
  creds: AgentCredentials,
): Promise<ReadExtendedResult> {
  validateReadOptions(opts);

  const maxFiles = opts.maxFiles ?? 20;
  const isStat = opts.stat === true;
  const lineOpts = { fromLine: opts.fromLine, toLine: opts.toLine, offset: opts.offset, limit: opts.limit };
  const hasLineRange = opts.fromLine !== undefined || opts.toLine !== undefined
    || opts.offset !== undefined || opts.limit !== undefined;

  // --- Single-path mode ---
  if (opts.path) {
    if (isStat) {
      // Validate security (resolvePathForRead ensures target is inside workspace)
      resolvePathForRead(workspaceRoot, opts.path);
      // Use the logical (pre-realpath) path so lstatSync can detect symlinks
      const rootReal = realpathSync(workspaceRoot);
      const logicalAbs = join(rootReal, opts.path);
      const raw = await toolStatRaw(workspaceRoot, logicalAbs, creds);
      return { kind: "stat-single", stat: buildFileStat(opts.path, raw) };
    }

    let content = await toolRead(workspaceRoot, opts.path, creds);
    if (hasLineRange) {
      content = sliceLines(content, lineOpts);
    }
    return { kind: "single", content };
  }

  // --- Multi-path / glob mode ---
  const patterns = opts.paths!;
  const { relativePaths, truncated } = resolvePathList(workspaceRoot, patterns, maxFiles);
  const rootReal = realpathSync(workspaceRoot);

  if (isStat) {
    const stats: FileStat[] = [];
    for (const relPath of relativePaths) {
      try {
        // Validate security (ensures resolved target is inside workspace)
        resolvePathForRead(workspaceRoot, relPath);
        // Use logical path so lstatSync can detect symlinks
        const logicalAbs = join(rootReal, relPath);
        const raw = await toolStatRaw(workspaceRoot, logicalAbs, creds);
        stats.push(buildFileStat(relPath, raw));
      } catch (e) {
        stats.push({
          path: relPath, size: 0, sizeHuman: "0 B", mtime: "", type: "other",
          permissions: "---------", error: (e as Error).message,
        });
      }
    }
    return { kind: "stat-multi", stats };
  }

  // Multi-file content read
  const files: Record<string, string> = {};
  const notices: string[] = [];
  let totalBytes = 0;

  for (const relPath of relativePaths) {
    try {
      let content = await toolRead(workspaceRoot, relPath, creds);

      // Skip binary files
      if (isBinaryContent(content)) {
        files[relPath] = "[binary file, skipped]";
        notices.push(`${relPath}: binary file, skipped`);
        continue;
      }

      // Apply line range if specified
      if (hasLineRange) {
        content = sliceLines(content, lineOpts);
      }

      // Truncate per-file
      const { content: trimmed, truncated: fileTruncated } = truncateContent(content);
      content = trimmed;
      if (fileTruncated) {
        notices.push(`${relPath}: truncated to ${PER_FILE_MAX_LINES} lines / ${formatSize(PER_FILE_MAX_BYTES)}`);
      }

      // Check total response budget
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (totalBytes + contentBytes > PER_FILE_MAX_BYTES) {
        notices.push(`${relPath}: omitted (total response size would exceed ${formatSize(PER_FILE_MAX_BYTES)})`);
        // Mark remaining files as omitted
        const idx = relativePaths.indexOf(relPath);
        for (let i = idx + 1; i < relativePaths.length; i++) {
          notices.push(`${relativePaths[i]}: omitted (total response size budget exhausted)`);
        }
        break;
      }

      totalBytes += contentBytes;
      files[relPath] = content;
    } catch (e) {
      files[relPath] = `[error: ${(e as Error).message}]`;
      notices.push(`${relPath}: ${(e as Error).message}`);
    }
  }

  if (truncated) {
    notices.push(`Results capped at ${maxFiles} files.`);
  }

  if (relativePaths.length === 0) {
    notices.push("No files matched the provided patterns.");
  }

  return { kind: "multi", files, notices: notices.length > 0 ? notices : undefined };
}

// ---------------------------------------------------------------------------
// Extended exec types
// ---------------------------------------------------------------------------

/** Which end of the output to keep when truncation is needed. */
export type TruncationMode = "head" | "tail" | "both";

/** Options for the extended exec tool. All fields except `command` are optional. */
export interface ExecExtendedOptions {
  /** The command to execute (passed to the shell). */
  command: string;
  /** Maximum execution time in seconds. Process is killed (SIGTERM → SIGKILL) if exceeded. */
  timeout?: number;
  /** String to write to the process's stdin, then close it. */
  stdin?: string;
  /** Working directory. Absolute or relative to the workspace root. */
  workdir?: string;
  /** Key-value pairs merged into the process's environment. */
  env?: Record<string, string>;
  /** When true, return stdout and stderr as separate fields. Default false. */
  splitStreams?: boolean;
  /** Maximum characters to return per stream (or combined). Overrides system default. */
  maxOutput?: number;
  /** Which end to keep when output exceeds the limit. Default "tail". */
  truncation?: TruncationMode;
  /** When true, start the process in the background immediately. */
  background?: boolean;
  /**
   * Wait up to this many milliseconds for the process to complete.
   * If it finishes in time, return the result normally.
   * If still running, background it and return a handle.
   * Mutually exclusive with `background: true` (background wins).
   */
  yieldMs?: number;
}

/** Result when the process ran to completion (foreground). */
export interface ExecForegroundResult {
  kind: "foreground";
  /** Combined output (when splitStreams is false). */
  output?: string;
  /** Separate stdout (when splitStreams is true). */
  stdout?: string;
  /** Separate stderr (when splitStreams is true). */
  stderr?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when the process was killed due to timeout. */
  timedOut?: boolean;
  /** True when the combined output was truncated. */
  truncated?: boolean;
  /** True when stdout was truncated (splitStreams mode). */
  stdoutTruncated?: boolean;
  /** True when stderr was truncated (splitStreams mode). */
  stderrTruncated?: boolean;
}

/** Result when the process was sent to the background. */
export interface ExecBackgroundResult {
  kind: "background";
  sessionId: string;
  pid: number;
  status: "running";
  /** True when the process was backgrounded via yieldMs expiry. */
  yielded?: boolean;
  /** Partial output captured before the process was backgrounded. */
  partialOutput?: string;
}

export type ExecExtendedResult = ExecForegroundResult | ExecBackgroundResult;

// ---------------------------------------------------------------------------
// Extended exec — output truncation helpers
// ---------------------------------------------------------------------------

/** System-enforced upper bound on maxOutput to prevent memory issues. */
const MAX_OUTPUT_SYSTEM_CAP = 1_024_000; // ~1 MB

/** Default max output characters when no maxOutput is specified. */
const MAX_OUTPUT_DEFAULT = 200_000; // 200 KB

/**
 * Truncate a string according to the specified mode.
 * Returns { text, truncated }.
 */
function truncateOutput(
  raw: string,
  maxChars: number,
  mode: TruncationMode,
): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false };
  }

  switch (mode) {
    case "head":
      return {
        text: raw.slice(0, maxChars) + `\n[... truncated ${raw.length - maxChars} characters ...]`,
        truncated: true,
      };
    case "tail":
      return {
        text: `[... truncated ${raw.length - maxChars} characters ...]\n` + raw.slice(-maxChars),
        truncated: true,
      };
    case "both": {
      const half = Math.floor(maxChars / 2);
      const gap = raw.length - maxChars;
      return {
        text: raw.slice(0, half) + `\n[... truncated ${gap} characters ...]\n` + raw.slice(-half),
        truncated: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Process Manager integration (optional)
// ---------------------------------------------------------------------------

/** Module-level ProcessManager instance. When set, background processes are
 *  managed through procman instead of the ad-hoc backgroundSessions Map. */
let _processManager: ProcessManager | undefined;

/** Set the ProcessManager instance for background process tracking. */
export function setProcessManager(pm: ProcessManager | undefined): void {
  _processManager = pm;
}

/** Get the current ProcessManager instance (if any). */
export function getProcessManager(): ProcessManager | undefined {
  return _processManager;
}

// ---------------------------------------------------------------------------
// Extended exec — session registry for background processes
// ---------------------------------------------------------------------------

/** Registry of background exec sessions, keyed by sessionId (legacy fallback). */
const backgroundSessions = new Map<string, BackgroundHandle>();

/** Counter for generating unique procman spec IDs. */
let _procmanCounter = 0;

/** Generate a unique procman-compatible spec ID for exec sessions. */
function nextProcmanId(): string {
  return `exec-${Date.now().toString(36)}-${(++_procmanCounter).toString(36)}`;
}

/**
 * Retrieve a background session by ID.
 * When a ProcessManager is set, checks procman first.
 * Falls back to the legacy Map.
 */
export function getExecSession(sessionId: string): BackgroundHandle | undefined {
  return backgroundSessions.get(sessionId);
}

/**
 * Get a procman-managed process by session ID.
 * Returns undefined when no ProcessManager is set or the ID is not found.
 */
export function getManagedExecSession(sessionId: string): ManagedProcess | undefined {
  return _processManager?.get(sessionId);
}

/**
 * List all tracked background sessions (legacy Map).
 * When a ProcessManager is set, procman-managed sessions are NOT included here —
 * use `getProcessManager()?.listByOwner(...)` to query those.
 */
export function listExecSessions(): Map<string, BackgroundHandle> {
  return backgroundSessions;
}

/**
 * Remove a completed session from the registry.
 * When a ProcessManager is set, stops and removes the process from procman.
 * Falls back to the legacy Map.
 */
export function removeExecSession(sessionId: string): boolean {
  // Check procman first
  if (_processManager) {
    const mp = _processManager.get(sessionId);
    if (mp) {
      // Fire-and-forget stop — the process may already be dead
      _processManager.stop(sessionId).catch(() => {});
      return true;
    }
  }
  return backgroundSessions.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Extended exec — validation
// ---------------------------------------------------------------------------

function validateExecOptions(opts: ExecExtendedOptions): void {
  if (!opts.command || opts.command.trim().length === 0) {
    throw new Error("`command` is required and must be non-empty.");
  }
  if (opts.timeout !== undefined && (typeof opts.timeout !== "number" || opts.timeout <= 0)) {
    throw new Error("`timeout` must be a positive number (seconds).");
  }
  if (opts.maxOutput !== undefined && (typeof opts.maxOutput !== "number" || opts.maxOutput <= 0)) {
    throw new Error("`maxOutput` must be a positive number.");
  }
  if (opts.truncation !== undefined && !["head", "tail", "both"].includes(opts.truncation)) {
    throw new Error('`truncation` must be "head", "tail", or "both".');
  }
  if (opts.yieldMs !== undefined && (typeof opts.yieldMs !== "number" || opts.yieldMs < 0)) {
    throw new Error("`yieldMs` must be a non-negative number.");
  }
}

// ---------------------------------------------------------------------------
// Extended exec — main function
// ---------------------------------------------------------------------------

/**
 * Extended exec tool supporting timeout, stdin, workdir, env overrides,
 * split streams, output truncation, background execution, and yield-based
 * backgrounding.
 *
 * All new parameters are optional — when called with just `command`, behavior
 * is equivalent to the original `toolExec`.
 */
export async function toolExecExtended(
  workspaceRoot: string,
  opts: ExecExtendedOptions,
  creds: AgentCredentials,
): Promise<ExecExtendedResult> {
  validateExecOptions(opts);

  const rootCwd = realpathSync(workspaceRoot);

  // Resolve working directory
  let cwd = rootCwd;
  if (opts.workdir) {
    const resolved = resolve(rootCwd, opts.workdir);
    if (!existsSync(resolved)) {
      throw new Error(`workdir does not exist: ${opts.workdir}`);
    }
    cwd = realpathSync(resolved);
  }

  // Merge env: workspace XDG defaults + user overrides
  const env: NodeJS.ProcessEnv = {
    ...xdgEnvForWorkspace(rootCwd),
    ...(opts.env as NodeJS.ProcessEnv | undefined),
  };

  // Resolve output limits
  const maxOutput = Math.min(opts.maxOutput ?? MAX_OUTPUT_DEFAULT, MAX_OUTPUT_SYSTEM_CAP);
  const truncationMode: TruncationMode = opts.truncation ?? "tail";
  const splitStreams = opts.splitStreams ?? false;

  // Build spawn options
  const spawnOpts = {
    file: "/bin/sh",
    args: ["-c", opts.command],
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    stdin: opts.stdin,
    env,
    timeout: opts.timeout,
  };

  // --- Background mode (immediate) ---
  // background: true wins over yieldMs; yieldMs of 0 is also immediate background.
  if (opts.background || (opts.yieldMs !== undefined && opts.yieldMs === 0)) {
    // When a ProcessManager is available, start via procman
    if (_processManager) {
      const specId = nextProcmanId();
      const spec: ProcessSpec = {
        id: specId,
        owner: { kind: "agent-tool", scopeId: "exec" },
        command: "/bin/sh",
        args: ["-c", opts.command],
        cwd,
        uid: creds.uid,
        gid: creds.gid,
        env: env as Record<string, string>,
        restart: { mode: "never" },
        stdio: { capture: "pipe", stdin: false },
        limits: opts.timeout ? { maxRuntimeSeconds: opts.timeout } : undefined,
      };
      const mp = await _processManager.start(spec);
      return {
        kind: "background",
        sessionId: specId,
        pid: mp.pid!,
        status: "running",
      };
    }

    const handle = spawnAsUser(spawnOpts);
    backgroundSessions.set(handle.sessionId, handle);

    // Clean up session when process exits
    handle.done.then(() => {
      // Keep in registry for polling — caller removes via removeExecSession
    });

    return {
      kind: "background",
      sessionId: handle.sessionId,
      pid: handle.pid,
      status: "running",
    };
  }

  // --- Yield-based backgrounding ---
  if (opts.yieldMs !== undefined && opts.yieldMs > 0) {
    // When a ProcessManager is available, start via procman
    if (_processManager) {
      const specId = nextProcmanId();
      const spec: ProcessSpec = {
        id: specId,
        owner: { kind: "agent-tool", scopeId: "exec" },
        command: "/bin/sh",
        args: ["-c", opts.command],
        cwd,
        uid: creds.uid,
        gid: creds.gid,
        env: env as Record<string, string>,
        restart: { mode: "never" },
        stdio: { capture: "pipe", stdin: false },
        limits: opts.timeout ? { maxRuntimeSeconds: opts.timeout } : undefined,
      };
      const mp = await _processManager.start(spec);

      // Wait up to yieldMs for the process to finish
      const finished = await Promise.race([
        new Promise<true>((resolve) => {
          mp.on("state-change", (state: string) => {
            if (state === "dead" || state === "exited") resolve(true);
          });
          // Already dead?
          if (mp.state === "dead" || mp.state === "exited") resolve(true);
        }),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), opts.yieldMs)),
      ]);

      if (finished) {
        // Process completed within the yield window — build foreground result
        const stdout = mp.readOutput("stdout");
        const stderr = mp.readOutput("stderr");
        // Clean up from procman since we're returning a foreground result
        _processManager.stop(specId).catch(() => {});
        return buildForegroundResultFromParts(
          stdout, stderr,
          mp.lastExitCode, mp.lastSignal, false,
          splitStreams, maxOutput, truncationMode,
        );
      }

      // Still running — keep in procman, return background handle
      const partialStdout = mp.readOutput("stdout");
      const partialStderr = mp.readOutput("stderr");
      const partialOutput = (partialStdout + partialStderr).slice(0, maxOutput) || undefined;

      return {
        kind: "background",
        sessionId: specId,
        pid: mp.pid!,
        status: "running",
        yielded: true,
        partialOutput,
      };
    }

    const handle = spawnAsUser(spawnOpts);

    // Wait up to yieldMs for the process to finish
    const finished = await Promise.race([
      handle.done.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), opts.yieldMs)),
    ]);

    if (finished) {
      // Process completed within the yield window — return full result
      return buildForegroundResult(handle, splitStreams, maxOutput, truncationMode);
    }

    // Still running — register and return background handle
    backgroundSessions.set(handle.sessionId, handle);

    const partialStdout = readHandleOutput(handle, "stdout");
    const partialStderr = readHandleOutput(handle, "stderr");
    const partialOutput = (partialStdout + partialStderr).slice(0, maxOutput) || undefined;

    return {
      kind: "background",
      sessionId: handle.sessionId,
      pid: handle.pid,
      status: "running",
      yielded: true,
      partialOutput,
    };
  }

  // --- Foreground (default) ---
  const result = await runAsUser(spawnOpts);
  return buildForegroundResultFromRaw(result, splitStreams, maxOutput, truncationMode);
}

/**
 * Build a foreground result from a completed BackgroundHandle.
 */
function buildForegroundResult(
  handle: BackgroundHandle,
  splitStreams: boolean,
  maxOutput: number,
  truncationMode: TruncationMode,
): ExecForegroundResult {
  const stdout = readHandleOutput(handle, "stdout");
  const stderr = readHandleOutput(handle, "stderr");

  return buildForegroundResultFromParts(
    stdout, stderr,
    handle.exitCode, handle.signal, handle.timedOut,
    splitStreams, maxOutput, truncationMode,
  );
}

/**
 * Build a foreground result from a RunAsUserResult.
 */
function buildForegroundResultFromRaw(
  r: RunAsUserResult,
  splitStreams: boolean,
  maxOutput: number,
  truncationMode: TruncationMode,
): ExecForegroundResult {
  return buildForegroundResultFromParts(
    r.stdout, r.stderr,
    r.exitCode, r.signal, r.timedOut ?? false,
    splitStreams, maxOutput, truncationMode,
  );
}

/**
 * Core builder for foreground results — handles split streams and truncation.
 */
function buildForegroundResultFromParts(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  splitStreams: boolean,
  maxOutput: number,
  truncationMode: TruncationMode,
): ExecForegroundResult {
  if (splitStreams) {
    const outT = truncateOutput(stdout, maxOutput, truncationMode);
    const errT = truncateOutput(stderr, maxOutput, truncationMode);
    return {
      kind: "foreground",
      stdout: outT.text,
      stderr: errT.text,
      exitCode,
      signal,
      timedOut: timedOut || undefined,
      stdoutTruncated: outT.truncated || undefined,
      stderrTruncated: errT.truncated || undefined,
    };
  }

  // Combined output
  const combined = stdout + stderr;
  const t = truncateOutput(combined, maxOutput, truncationMode);
  return {
    kind: "foreground",
    output: t.text,
    exitCode,
    signal,
    timedOut: timedOut || undefined,
    truncated: t.truncated || undefined,
  };
}
