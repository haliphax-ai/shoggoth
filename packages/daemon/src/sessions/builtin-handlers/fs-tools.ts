// builtin-fs / builtin-read / builtin-write — file system tools.
// registerFsTools: mutating fs ops. registerFsReadWrite: read/write.

import { extname, isAbsolute, join as pathJoin, relative } from "node:path";
import {
  resolvePathForRead,
  resolvePathForWrite,
  toolRead,
  toolReadBinary,
  toolReadExtended,
  toolWrite,
  type ReadExtendedOptions,
} from "@shoggoth/os-exec";
import { IMAGE_EXTENSION_TO_MIME, MAX_IMAGE_BLOCK_BYTES } from "@shoggoth/shared";
import type { ChatContentPart } from "@shoggoth/models";
import type {
  BuiltinToolRegistry,
  BuiltinToolContext,
  BuiltinToolResult,
} from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { truncateToolOutput } from "./truncate-output";
import { getFsHelperClient } from "../fs-helper-process";
import { checkAgentsMdGate } from "../agents-md-gate";
import { checkReReadRequired, clearReReadRequired } from "../re-read-required";
import { getSessionContextSegmentId } from "../session-store";

export function registerFsTools(registry: BuiltinToolRegistry): void {
  registry.register("fs", fsHandler);
}

export function registerFsReadWrite(registry: BuiltinToolRegistry): void {
  registry.register("read", readHandler);
  registry.register("write", writeHandler);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run one fs mutation command in the session's persistent helper process
 * (spawned via procman under the agent UID/GID on first use). Throws with the
 * helper's error message on failure, preserving the former `runScript`
 * error behavior for callers.
 */
async function runHelper(
  ctx: BuiltinToolContext,
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const processManager = ctx.getProcessManager();
  if (!processManager) {
    throw new Error("process manager not initialized; cannot run fs helper");
  }
  const helper = getFsHelperClient(ctx.sessionId, {
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
    workspacePath: ctx.workspaceRealPath,
    processManager,
  });
  const result = await helper.request(action, params);
  if (result.ok !== true) {
    throw new Error(
      typeof result.error === "string" ? result.error : `helper action failed: ${action}`,
    );
  }
  return result;
}

/** Resolve a user-supplied path for read (must exist, symlinks resolved inside workspace). */
function resolveSrc(ctx: BuiltinToolContext, userPath: string): string {
  return resolvePathForRead(ctx.workspacePath, resolveUserPath(ctx, userPath));
}

/** Resolve a user-supplied path for write (parent must resolve inside workspace). */
function resolveDst(ctx: BuiltinToolContext, userPath: string): string {
  return resolvePathForWrite(ctx.workspacePath, resolveUserPath(ctx, userPath));
}

/** Return a workspace-relative path for display. */
function relPath(ctx: BuiltinToolContext, abs: string): string {
  const root = ctx.workspaceRealPath;
  return relative(root, abs);
}

/** Validate the octal mode string (3 or 4 digits, each 0-7). */
function isValidMode(mode: string): boolean {
  return /^[0-7]{3,4}$/.test(mode);
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

/**
 * Shared body for the two-argument actions (move, copy): validate `dest`,
 * resolve both paths (the source resolver differs per action — move already
 * requires an existing source so it uses the write resolver's parent check),
 * run the helper op, and report the from/to pair.
 */
async function runSrcDstAction(
  ctx: BuiltinToolContext,
  args: FsArgs,
  action: "move" | "copy",
  resolveSrcPath: (ctx: BuiltinToolContext, userPath: string) => string,
): Promise<BuiltinToolResult> {
  if (!args.dest) throw new Error(`\`dest\` is required for ${action}`);
  const src = resolveSrcPath(ctx, args.path);
  const dst = resolveDst(ctx, args.dest);

  await runHelper(ctx, action, { src, dst });
  return {
    resultJson: JSON.stringify({
      ok: true,
      action,
      from: relPath(ctx, src),
      to: relPath(ctx, dst),
    }),
  };
}

async function doMove(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  return runSrcDstAction(ctx, args, "move", resolveDst);
}

async function doCopy(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  return runSrcDstAction(ctx, args, "copy", resolveSrc);
}

async function doDelete(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  const src = resolveDst(ctx, args.path);
  const recursive = args.recursive === true;

  const result = await runHelper(ctx, "delete", { src, recursive });
  const count = typeof result.count === "number" ? result.count : 0;
  return {
    resultJson: JSON.stringify({
      ok: true,
      action: "delete",
      path: relPath(ctx, src),
      count,
    }),
  };
}

async function doStat(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  const src = resolveSrc(ctx, args.path);

  const result = await runHelper(ctx, "stat", { src });
  const info = (result.info ?? {}) as {
    type: string;
    size: number;
    mtime: string;
    atime: string;
    mode: string;
    uid: number;
    gid: number;
  };

  return {
    resultJson: JSON.stringify({
      ok: true,
      action: "stat",
      path: relPath(ctx, src),
      ...info,
    }),
  };
}

async function doChmod(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  if (!args.mode) throw new Error("`mode` is required for chmod");
  if (!isValidMode(args.mode)) {
    throw new Error(
      `invalid mode "${args.mode}": expected 3 or 4 octal digits (e.g. "755", "0644")`,
    );
  }
  const src = resolveDst(ctx, args.path);
  const modeInt = parseInt(args.mode, 8).toString();

  await runHelper(ctx, "chmod", { src, modeInt });
  return {
    resultJson: JSON.stringify({
      ok: true,
      action: "chmod",
      path: relPath(ctx, args.path),
      mode: args.mode,
    }),
  };
}

// ---------------------------------------------------------------------------
// Main handler dispatch
// ---------------------------------------------------------------------------

async function doMkdir(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  const dst = resolveDst(ctx, args.path);
  const recursive = args.recursive === true;

  await runHelper(ctx, "mkdir", { src: dst, recursive });

  return {
    resultJson: JSON.stringify({
      ok: true,
      action: "mkdir",
      path: relPath(ctx, dst),
    }),
  };
}

type FsAction = "move" | "copy" | "delete" | "stat" | "chmod" | "mkdir";

interface FsArgs {
  action: FsAction;
  path: string;
  dest?: string;
  mode?: string;
  recursive?: boolean;
}

const ACTIONS: Record<
  FsAction,
  (ctx: BuiltinToolContext, args: FsArgs) => Promise<BuiltinToolResult>
> = {
  move: doMove,
  copy: doCopy,
  delete: doDelete,
  stat: doStat,
  chmod: doChmod,
  mkdir: doMkdir,
};

async function fsHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  const action = String(args.action ?? "") as FsAction;
  if (!action || !(action in ACTIONS)) {
    throw new Error(
      `invalid action "${action}"; expected one of: ${Object.keys(ACTIONS).join(", ")}`,
    );
  }
  if (!args.path) {
    throw new Error("`path` is required");
  }

  // AGENTS.md discovery gate — mutating actions only
  const MUTATING: Set<FsAction> = new Set(["move", "copy", "delete", "mkdir"]);
  if (MUTATING.has(action)) {
    const cwd = ctx.workingDirectory ?? ctx.workspacePath;
    const gate = checkAgentsMdGate(ctx.db, ctx.sessionId, cwd, ctx.workspacePath);
    if (gate) return { resultJson: JSON.stringify(gate) };
  }

  const fsArgs: FsArgs = {
    action,
    path: String(args.path),
    dest: args.dest != null ? String(args.dest) : undefined,
    mode: args.mode != null ? String(args.mode) : undefined,
    recursive: args.recursive === true,
  };

  return ACTIONS[action](ctx, fsArgs);
}

// ---------------------------------------------------------------------------
// Read / write handlers (builtin-read, builtin-write)
// ---------------------------------------------------------------------------

/**
 * Convert a resolved absolute path back to workspace-relative.
 * toolReadExtended expects workspace-relative paths because it internally
 * joins them with the workspace root. If the path is already relative or
 * escapes the workspace (e.g. /app docs), return it as-is for the security
 * layer in os-exec to handle.
 */
function toWorkspaceRelative(ctx: BuiltinToolContext, absolutePath: string): string {
  if (!isAbsolute(absolutePath)) return absolutePath;
  const rel = relative(ctx.workspacePath, absolutePath);
  if (rel.startsWith("..")) return absolutePath;
  return rel;
}

/**
 * Whether `ctx.db` looks like a real better-sqlite3 handle. Tests that
 * exercise unrelated code paths may pass a stub `db: {} as any`; in that
 * case the re-read gate is a no-op.
 */
function hasRealDb(ctx: BuiltinToolContext): boolean {
  return typeof (ctx.db as { prepare?: unknown })?.prepare === "function";
}

/**
 * Run `fn` only when `ctx.db` is a real better-sqlite3 handle (tests may pass
 * a stub `db`); swallow errors so the gate never blocks on internal issues.
 */
function withDbGate(ctx: BuiltinToolContext, fn: (segmentId: string) => void): void {
  if (!hasRealDb(ctx)) return;
  try {
    fn(getSessionContextSegmentId(ctx.db, ctx.sessionId));
  } catch {
    // ignore
  }
}

/**
 * Clear the re-read flag for `absPath` in the current segment. Used by the
 * read handler after a successful content read so that subsequent edits
 * are not gated as stale. Best-effort: never throws.
 */
function clearReReadFlag(ctx: BuiltinToolContext, absPath: string): void {
  withDbGate(ctx, (segmentId) => clearReReadRequired(ctx.db, ctx.sessionId, segmentId, absPath));
}

/**
 * Clear the re-read flag for every file in a multi-file read result.
 * `result.files` keys are workspace-relative; convert to absolute before
 * looking up the gate. Best-effort: never throws.
 */
function clearMultiReReadFlags(ctx: BuiltinToolContext, files: Record<string, string>): void {
  withDbGate(ctx, (segmentId) => {
    for (const relPath of Object.keys(files)) {
      const abs = pathJoin(ctx.workspacePath, relPath);
      clearReReadRequired(ctx.db, ctx.sessionId, segmentId, abs);
    }
  });
}

/**
 * Look up the re-read gate for `absPath` in the current segment. Returns
 * the gate result payload if blocked, null otherwise. Best-effort: returns
 * null on any internal error so a stale db state cannot block writes.
 */
function reReadGateFor(ctx: BuiltinToolContext, absPath: string): unknown | null {
  if (!hasRealDb(ctx)) return null;
  try {
    return checkReReadRequired(
      ctx.db,
      ctx.sessionId,
      getSessionContextSegmentId(ctx.db, ctx.sessionId),
      absPath,
    );
  } catch {
    return null;
  }
}

/**
 * Format a file body for a read result. With `lines`/`lineNumbers`, the
 * body is split into lines (LF, CRLF, CR), optionally numbered 1-indexed,
 * and capped at 1000 lines with a notice (the line cap applies when `lines`
 * is set). The final joined output always goes through truncateToolOutput
 * so a small number of enormous lines cannot produce an unbounded result;
 * when the byte cap kicks in, the head/tail string form replaces the array.
 * Without those flags the body is truncated by character count only.
 */
function formatBodyLines(body: string, lines: boolean, lineNumbers: boolean): string | string[] {
  if (!lines && !lineNumbers) return truncateToolOutput(body);

  const rawLines = body.split(/\r\n|\n|\r/);
  const numbered = (ls: string[]) => ls.map((line, index) => `${index + 1}: ${line}`);

  let content: string[] = lineNumbers ? numbered(rawLines) : rawLines;
  if (lines && rawLines.length > 1000) {
    const cappedLines = rawLines.slice(0, 1000);
    content = [
      ...(lineNumbers ? numbered(cappedLines) : cappedLines),
      `[... truncated — file has ${rawLines.length} lines, showing first 1000 ...]`,
    ];
  }

  const joined = content.join("\n");
  const cappedOutput = truncateToolOutput(joined);
  return cappedOutput === joined ? content : cappedOutput;
}

type ReadResult = { resultJson: string; contentParts?: ChatContentPart[] };

interface ReadArgs {
  path: string;
  paths?: string[];
  lines: boolean;
  lineNumbers: boolean;
  fromLine?: number;
  toLine?: number;
  offset?: number;
  limit?: number;
  stat: boolean;
  maxFiles?: number;
}

function parseReadArgs(args: Record<string, unknown>): ReadArgs {
  return {
    path: String(args.path ?? ""),
    paths: args.paths as string[] | undefined,
    lines: args.lines === true,
    lineNumbers: args.lineNumbers === true,
    fromLine: typeof args.fromLine === "number" ? args.fromLine : undefined,
    toLine: typeof args.toLine === "number" ? args.toLine : undefined,
    offset: typeof args.offset === "number" ? args.offset : undefined,
    limit: typeof args.limit === "number" ? args.limit : undefined,
    stat: args.stat === true,
    maxFiles: typeof args.maxFiles === "number" ? args.maxFiles : undefined,
  };
}

/** Single-path image read: inline the image as model content parts. */
async function readImage(
  ctx: BuiltinToolContext,
  parsed: ReadArgs,
  resolvedPath: string,
  imageMime: string,
): Promise<ReadResult> {
  if (!ctx.imageBlockCodec) {
    return {
      resultJson: JSON.stringify({
        error: "Image content not supported by the active model provider.",
        path: parsed.path,
      }),
    };
  }
  const buf = await toolReadBinary(ctx.workspacePath, resolvedPath, ctx.creds);
  if (buf.length > MAX_IMAGE_BLOCK_BYTES) {
    const sizeMB = (buf.length / (1024 * 1024)).toFixed(1);
    return {
      resultJson: JSON.stringify({
        error: `Image too large to include in context (${sizeMB} MB, limit ${MAX_IMAGE_BLOCK_BYTES / (1024 * 1024)} MB). Consider resizing.`,
        path: parsed.path,
      }),
    };
  }
  const contentParts: ChatContentPart[] = [
    { type: "image", mediaType: imageMime, base64: buf.toString("base64") },
    { type: "text", text: `Image file: ${parsed.path}` },
  ];
  clearReReadFlag(ctx, resolvedPath);
  return { resultJson: JSON.stringify({ path: parsed.path }), contentParts };
}

/** Multi-file / ranged / stat reads (toolReadExtended). */
async function readExtended(
  ctx: BuiltinToolContext,
  parsed: ReadArgs,
  resolvedPath: string,
): Promise<ReadResult> {
  const resolvedPaths = parsed.paths?.map((p) => toWorkspaceRelative(ctx, resolveUserPath(ctx, p)));
  const opts: ReadExtendedOptions = {
    path: parsed.paths ? undefined : toWorkspaceRelative(ctx, resolvedPath),
    paths: resolvedPaths,
    fromLine: parsed.fromLine,
    toLine: parsed.toLine,
    offset: parsed.offset,
    limit: parsed.limit,
    stat: parsed.stat,
    maxFiles: parsed.maxFiles,
  };
  const result = await toolReadExtended(ctx.workspacePath, opts, ctx.creds);
  if (result.kind === "stat-single") {
    return { resultJson: JSON.stringify({ path: parsed.path, stat: result.stat }) };
  }
  if (result.kind === "stat-multi") {
    return { resultJson: JSON.stringify({ stats: result.stats }) };
  }
  if (result.kind === "multi") {
    clearMultiReReadFlags(ctx, result.files);
    return { resultJson: JSON.stringify({ files: result.files, notices: result.notices }) };
  }
  clearReReadFlag(ctx, resolvedPath);
  return {
    resultJson: JSON.stringify({
      path: parsed.path,
      content: formatBodyLines(result.content, parsed.lines, parsed.lineNumbers),
    }),
  };
}

async function readHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<ReadResult> {
  const parsed = parseReadArgs(args);
  const resolvedPath = resolveUserPath(ctx, parsed.path);
  const imageMime = IMAGE_EXTENSION_TO_MIME[extname(parsed.path).toLowerCase()];

  if (parsed.path && imageMime) return readImage(ctx, parsed, resolvedPath, imageMime);

  const firstRange = parsed.fromLine ?? parsed.toLine ?? parsed.offset ?? parsed.limit;
  if (parsed.stat || firstRange !== undefined || (parsed.paths?.length ?? 0) > 0) {
    return readExtended(ctx, parsed, resolvedPath);
  }

  const body = await toolRead(ctx.workspacePath, resolvedPath, ctx.creds);
  clearReReadFlag(ctx, resolvedPath);
  return {
    resultJson: JSON.stringify({
      path: parsed.path,
      content: formatBodyLines(body, parsed.lines, parsed.lineNumbers),
    }),
  };
}

async function writeHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const cwd = ctx.workingDirectory ?? ctx.workspacePath;
  const gate = checkAgentsMdGate(ctx.db, ctx.sessionId, cwd, ctx.workspacePath);
  if (gate) return { resultJson: JSON.stringify(gate) };

  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  const append = args.append === true;
  const resolvedPath = resolveUserPath(ctx, path);

  // Re-read gate (consumer): refuse to overwrite/append a file the agent
  // hasn't re-read since the last line-shifting replace.
  const reReadGate = reReadGateFor(ctx, resolvedPath);
  if (reReadGate) return { resultJson: JSON.stringify(reReadGate) };

  await toolWrite(
    ctx.workspacePath,
    { path: resolvedPath, content, append, mkdirp: true },
    ctx.creds,
  );
  return { resultJson: JSON.stringify({ ok: true, path }) };
}
