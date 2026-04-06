// ---------------------------------------------------------------------------
// builtin-fs — file operations: move, copy, delete, stat, chmod, rename, mkdir
// ---------------------------------------------------------------------------

import { realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { resolvePathForRead, resolvePathForWrite, runAsUser } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext, BuiltinToolResult } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";

type FsAction = "move" | "copy" | "delete" | "stat" | "chmod" | "rename" | "mkdir";

interface FsArgs {
  action: FsAction;
  path: string;
  dest?: string;
  mode?: string;
  recursive?: boolean;
}

export function register(registry: BuiltinToolRegistry): void {
  registry.register("fs", fsHandler);
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
  const cwd = realpathSync(ctx.workspacePath);
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
  const root = realpathSync(ctx.workspacePath);
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
  const src = resolveSrc(ctx, args.path);
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
  const src = resolveSrc(ctx, args.path);
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
    throw new Error(`invalid mode "${args.mode}": expected 3 or 4 octal digits (e.g. "755", "0644")`);
  }
  const src = resolveSrc(ctx, args.path);
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

async function doRename(ctx: BuiltinToolContext, args: FsArgs): Promise<BuiltinToolResult> {
  if (!args.dest) throw new Error("`dest` is required for rename");

  // rename is same-directory only — dest must be a bare filename
  const destBase = basename(args.dest);
  if (args.dest !== destBase && args.dest !== `./${destBase}`) {
    throw new Error("`rename` is same-directory only; use `move` for cross-directory operations");
  }

  const src = resolveSrc(ctx, args.path);
  const srcDir = dirname(src);
  const dst = join(srcDir, destBase);

  // Ensure the destination still resolves inside the workspace
  const rootReal = realpathSync(ctx.workspacePath);
  const rel = relative(rootReal, dst);
  if (rel.startsWith("..")) {
    throw new Error("destination escapes workspace");
  }

  const script = [
    `const fs = require("fs");`,
    `fs.renameSync(process.env._SRC, process.env._DST);`,
    `process.stdout.write("ok");`,
  ].join(" ");

  await runScript(ctx, script, { _SRC: src, _DST: dst });
  return {
    resultJson: JSON.stringify({
      ok: true,
      action: "rename",
      from: relPath(ctx, src),
      to: relPath(ctx, dst),
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

const ACTIONS: Record<FsAction, (ctx: BuiltinToolContext, args: FsArgs) => Promise<BuiltinToolResult>> = {
  move: doMove,
  copy: doCopy,
  delete: doDelete,
  stat: doStat,
  chmod: doChmod,
  rename: doRename,
  mkdir: doMkdir,
};

async function fsHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  const action = String(args.action ?? "") as FsAction;
  if (!action || !(action in ACTIONS)) {
    throw new Error(`invalid action "${action}"; expected one of: ${Object.keys(ACTIONS).join(", ")}`);
  }
  if (!args.path) {
    throw new Error("`path` is required");
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
