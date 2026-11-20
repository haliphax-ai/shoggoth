// builtin-fs / builtin-read / builtin-write — file system tools.
// registerFsTools: mutating fs ops. registerFsReadWrite: read/write.

import { extname, isAbsolute, join as pathJoin, relative } from "node:path";
import {
  resolvePathForRead,
  resolvePathForWrite,
  runAsUser,
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

/** Run a Node.js one-liner as the agent UID/GID and return stdout / throw on failure. */
async function runScript(
  ctx: BuiltinToolContext,
  script: string,
  env: Record<string, string> = {},
): Promise<string> {
  const cwd = ctx.workspaceRealPath;
  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", script],
    cwd,
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
    env,
  });
  if (r.exitCode !== 0) {
    throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
  }
  return r.stdout;
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

async function doMove(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  if (!args.dest) throw new Error("`dest` is required for move");
  const src = resolveDst(ctx, args.path);
  const dst = resolveDst(ctx, args.dest);

  const script = [
    `const fs = require("fs");`,
    `const src = process.env._SRC;`,
    `const dst = process.env._DST;`,
    `fs.mkdirSync(require("path").dirname(dst), { recursive: true });`,
    `fs.renameSync(src, dst);`,
    `process.stdout.write("ok");`,
  ].join(" ");

  await runScript(ctx, script, { _SRC: src, _DST: dst });
  return {
    resultJson: JSON.stringify({
      ok: true,
      action: "move",
      from: relPath(ctx, src),
      to: relPath(ctx, dst),
    }),
  };
}

async function doCopy(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  if (!args.dest) throw new Error("`dest` is required for copy");
  const src = resolveSrc(ctx, args.path);
  const dst = resolveDst(ctx, args.dest);

  const script = [
    `const fs = require("fs");`,
    `const path = require("path");`,
    `const src = process.env._SRC;`,
    `const dst = process.env._DST;`,
    `fs.mkdirSync(path.dirname(dst), { recursive: true });`,
    `fs.cpSync(src, dst, { recursive: true });`,
    `process.stdout.write("ok");`,
  ].join(" ");

  await runScript(ctx, script, { _SRC: src, _DST: dst });
  return {
    resultJson: JSON.stringify({
      ok: true,
      action: "copy",
      from: relPath(ctx, src),
      to: relPath(ctx, dst),
    }),
  };
}

async function doDelete(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  const src = resolveDst(ctx, args.path);
  const recursive = args.recursive === true;

  const script = [
    `const fs = require("fs");`,
    `const path = require("path");`,
    `const target = process.env._TARGET;`,
    `const recursive = process.env._RECURSIVE === "1";`,
    `const st = fs.lstatSync(target);`,
    `let count = 0;`,
    `if (st.isDirectory()) {`,
    `  const entries = fs.readdirSync(target);`,
    `  if (entries.length > 0 && !recursive) {`,
    `    process.stderr.write("directory is not empty; set recursive: true to delete");`,
    `    process.exit(1);`,
    `  }`,
    `  if (recursive) {`,
    `    function countDir(d) { let n = 0; for (const e of fs.readdirSync(d)) { const fp = path.join(d, e); const s = fs.lstatSync(fp); if (s.isDirectory()) { n += countDir(fp); } else { n++; } } return n + 1; } count = countDir(target);`,
    `  } else { count = 1; }`,
    `  fs.rmSync(target, { recursive: true, force: true });`,
    `} else {`,
    `  fs.unlinkSync(target);`,
    `  count = 1;`,
    `}`,
    `process.stdout.write(JSON.stringify({ count }));`,
  ].join(" ");

  const out = await runScript(ctx, script, {
    _TARGET: src,
    _RECURSIVE: recursive ? "1" : "0",
  });

  const { count } = JSON.parse(out) as { count: number };
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

  const script = [
    `const fs = require("fs");`,
    `const p = process.env._TARGET;`,
    `const lst = fs.lstatSync(p);`,
    `const isLink = lst.isSymbolicLink();`,
    `const st = isLink ? fs.statSync(p) : lst;`,
    `let type = "other";`,
    `if (st.isFile()) type = "file";`,
    `else if (st.isDirectory()) type = "directory";`,
    `const mode = "0" + (st.mode & 0o777).toString(8);`,
    `const out = {`,
    `  type,`,
    `  size: st.size,`,
    `  mtime: st.mtime.toISOString(),`,
    `  atime: st.atime.toISOString(),`,
    `  mode,`,
    `  uid: st.uid,`,
    `  gid: st.gid,`,
    `};`,
    `process.stdout.write(JSON.stringify(out));`,
  ].join(" ");

  const out = await runScript(ctx, script, { _TARGET: src });
  const info = JSON.parse(out) as {
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

  const script = [
    `const fs = require("fs");`,
    `fs.chmodSync(process.env._TARGET, parseInt(process.env._MODE, 10));`,
    `process.stdout.write("ok");`,
  ].join(" ");

  await runScript(ctx, script, { _TARGET: src, _MODE: modeInt });
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

  const script = [
    `const fs = require("fs");`,
    `const target = process.env._TARGET;`,
    `const recursive = process.env._RECURSIVE === "1";`,
    `try { if (fs.statSync(target).isDirectory()) { process.stdout.write("ok"); process.exit(0); } } catch {}`,
    `fs.mkdirSync(target, { recursive });`,
    `process.stdout.write("ok");`,
  ].join(" ");

  await runScript(ctx, script, {
    _TARGET: dst,
    _RECURSIVE: recursive ? "1" : "0",
  });

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
 * Clear the re-read flag for `absPath` in the current segment. Used by the
 * read handler after a successful content read so that subsequent edits
 * are not gated as stale. Best-effort: never throws.
 */
function clearReReadFlag(ctx: BuiltinToolContext, absPath: string): void {
  if (!hasRealDb(ctx)) return;
  try {
    const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
    clearReReadRequired(ctx.db, ctx.sessionId, segmentId, absPath);
  } catch {
    // ignore
  }
}

/**
 * Clear the re-read flag for every file in a multi-file read result.
 * `result.files` keys are workspace-relative; convert to absolute before
 * looking up the gate. Best-effort: never throws.
 */
function clearMultiReReadFlags(ctx: BuiltinToolContext, files: Record<string, string>): void {
  if (!hasRealDb(ctx)) return;
  try {
    const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
    for (const relPath of Object.keys(files)) {
      const abs = pathJoin(ctx.workspacePath, relPath);
      clearReReadRequired(ctx.db, ctx.sessionId, segmentId, abs);
    }
  } catch {
    // ignore
  }
}

/**
 * Look up the re-read gate for `absPath` in the current segment. Returns
 * the gate result payload if blocked, null otherwise. Best-effort: returns
 * null on any internal error so a stale db state cannot block writes.
 */
function reReadGateFor(ctx: BuiltinToolContext, absPath: string): unknown | null {
  if (!hasRealDb(ctx)) return null;
  try {
    const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
    return checkReReadRequired(ctx.db, ctx.sessionId, segmentId, absPath);
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

async function readHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string; contentParts?: ChatContentPart[] }> {
  const path = String(args.path ?? "");
  const paths = args.paths as string[] | undefined;
  const lines = args.lines === true;
  const lineNumbers = args.lineNumbers === true;
  const fromLine = typeof args.fromLine === "number" ? args.fromLine : undefined;
  const toLine = typeof args.toLine === "number" ? args.toLine : undefined;
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  const stat = args.stat === true;
  const maxFiles = typeof args.maxFiles === "number" ? args.maxFiles : undefined;

  const resolvedPath = resolveUserPath(ctx, path);
  const ext = extname(path).toLowerCase();
  const imageMime = IMAGE_EXTENSION_TO_MIME[ext];

  // Image handling (single path only)
  if (path && imageMime) {
    if (!ctx.imageBlockCodec) {
      return {
        resultJson: JSON.stringify({
          error: "Image content not supported by the active model provider.",
          path,
        }),
      };
    }
    const buf = await toolReadBinary(ctx.workspacePath, resolvedPath, ctx.creds);
    if (buf.length > MAX_IMAGE_BLOCK_BYTES) {
      const sizeMB = (buf.length / (1024 * 1024)).toFixed(1);
      return {
        resultJson: JSON.stringify({
          error: `Image too large to include in context (${sizeMB} MB, limit ${MAX_IMAGE_BLOCK_BYTES / (1024 * 1024)} MB). Consider resizing.`,
          path,
        }),
      };
    }
    const base64 = buf.toString("base64");
    const contentParts: ChatContentPart[] = [
      { type: "image", mediaType: imageMime, base64 },
      { type: "text", text: `Image file: ${path}` },
    ];
    clearReReadFlag(ctx, resolvedPath);
    return { resultJson: JSON.stringify({ path }), contentParts };
  }

  const hasExtended =
    (paths && paths.length > 0) ||
    fromLine !== undefined ||
    toLine !== undefined ||
    offset !== undefined ||
    limit !== undefined ||
    stat === true;

  if (hasExtended) {
    const resolvedPaths = paths?.map((p) => toWorkspaceRelative(ctx, resolveUserPath(ctx, p)));

    const opts: ReadExtendedOptions = {
      path: paths ? undefined : toWorkspaceRelative(ctx, resolvedPath),
      paths: resolvedPaths,
      fromLine,
      toLine,
      offset,
      limit,
      stat,
      maxFiles,
    };

    const result = await toolReadExtended(ctx.workspacePath, opts, ctx.creds);

    if (result.kind === "stat-single") {
      return { resultJson: JSON.stringify({ path, stat: result.stat }) };
    }
    if (result.kind === "stat-multi") {
      return { resultJson: JSON.stringify({ stats: result.stats }) };
    }

    if (result.kind === "multi") {
      const output: Record<string, unknown> = { files: result.files };
      if (result.notices) output.notices = result.notices;
      clearMultiReReadFlags(ctx, result.files);
      return { resultJson: JSON.stringify({ files: result.files, notices: result.notices }) };
    }

    const body = result.content;
    const content = formatBodyLines(body, lines, lineNumbers);

    clearReReadFlag(ctx, resolvedPath);
    return { resultJson: JSON.stringify({ path, content }) };
  }

  const body = await toolRead(ctx.workspacePath, resolvedPath, ctx.creds);

  const content = formatBodyLines(body, lines, lineNumbers);

  clearReReadFlag(ctx, resolvedPath);
  return { resultJson: JSON.stringify({ path, content }) };
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
