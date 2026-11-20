// fs helper entry — persistent per-session helper process for fs mutations.
// Spawned by the daemon via procman (one per session, first fs op), running as
// the agent UID/GID; NDJSON on stdio; plain TS via the tsx loader, no daemon imports.

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

interface FsHelperCommand {
  action?: unknown;
  id?: unknown;
  params?: Record<string, unknown>;
}

interface FsHelperParams {
  src?: unknown;
  dst?: unknown;
  recursive?: unknown;
  modeInt?: unknown;
}

/** Params for one fs op, loosely validated before the fs calls use them. */
function asPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${label} path`);
  }
  return value;
}

/** Recursively count entries in a directory tree (the directory itself included). */
function countDir(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir)) {
    const fp = path.join(dir, entry);
    const st = fs.lstatSync(fp);
    if (st.isDirectory()) {
      n += countDir(fp);
    } else {
      n++;
    }
  }
  return n + 1;
}

/** fs move: mkdir -p the destination parent, then rename. */
function doMove(params: FsHelperParams): Record<string, unknown> {
  const src = asPath(params.src, "source");
  const dst = asPath(params.dst, "destination");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return { ok: true };
}

/** fs copy: mkdir -p the destination parent, then recursive copy. */
function doCopy(params: FsHelperParams): Record<string, unknown> {
  const src = asPath(params.src, "source");
  const dst = asPath(params.dst, "destination");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  return { ok: true };
}

/** fs delete: refuse non-empty directories unless recursive; returns removed entry count. */
function doDelete(params: FsHelperParams): Record<string, unknown> {
  const target = asPath(params.src, "target");
  const recursive = params.recursive === true;
  const st = fs.lstatSync(target);
  let count = 0;
  if (st.isDirectory()) {
    const entries = fs.readdirSync(target);
    if (entries.length > 0 && !recursive) {
      return { ok: false, error: "directory is not empty; set recursive: true to delete" };
    }
    count = recursive ? countDir(target) : 1;
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.unlinkSync(target);
    count = 1;
  }
  return { ok: true, count };
}

/** fs stat: lstat, following the link for type/size/times when target is a symlink. */
function doStat(params: FsHelperParams): Record<string, unknown> {
  const src = asPath(params.src, "target");
  const lst = fs.lstatSync(src);
  const isLink = lst.isSymbolicLink();
  const st = isLink ? fs.statSync(src) : lst;
  let type = "other";
  if (st.isFile()) type = "file";
  else if (st.isDirectory()) type = "directory";
  return {
    ok: true,
    info: {
      type,
      size: st.size,
      mtime: st.mtime.toISOString(),
      atime: st.atime.toISOString(),
      mode: "0" + (st.mode & 0o777).toString(8),
      uid: st.uid,
      gid: st.gid,
    },
  };
}

/** fs chmod: apply a decimal-string mode (client sends parseInt(mode, 8).toString()). */
function doChmod(params: FsHelperParams): Record<string, unknown> {
  const src = asPath(params.src, "target");
  if (typeof params.modeInt !== "string" || !/^\d+$/.test(params.modeInt)) {
    throw new Error("missing or invalid modeInt (expect a decimal-string mode)");
  }
  fs.chmodSync(src, parseInt(params.modeInt, 10));
  return { ok: true };
}

/** fs mkdir: succeed silently when the target already is a directory. */
function doMkdir(params: FsHelperParams): Record<string, unknown> {
  const src = asPath(params.src, "target");
  const recursive = params.recursive === true;
  try {
    if (fs.statSync(src).isDirectory()) return { ok: true };
  } catch {
    // not there yet — create below
  }
  fs.mkdirSync(src, { recursive });
  return { ok: true };
}

const ACTIONS: Record<string, (params: FsHelperParams) => Record<string, unknown>> = {
  move: doMove,
  copy: doCopy,
  delete: doDelete,
  stat: doStat,
  chmod: doChmod,
  mkdir: doMkdir,
};

/** Execute one command object; never throws — failures come back as results. */
function execute(command: FsHelperCommand | undefined): Record<string, unknown> {
  const action = ACTIONS[String(command?.action ?? "")];
  if (!action) {
    return { ok: false, error: `unknown action: ${String(command?.action)}` };
  }
  try {
    return action(command?.params ?? {});
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let command: FsHelperCommand | undefined;
  try {
    command = JSON.parse(trimmed) as FsHelperCommand;
  } catch {
    // Unparseable frame: no id is recoverable, answer with a bare error result.
    process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid JSON frame" })}\n`);
    return;
  }
  // Echo the command id so the client can match responses to requests.
  const result = { ...execute(command), id: command?.id };
  process.stdout.write(`${JSON.stringify(result)}\n`);
});

// stdin EOF (parent stopped/crashed) — exit so procman records a clean stop.
rl.on("close", () => {
  process.exit(0);
});
