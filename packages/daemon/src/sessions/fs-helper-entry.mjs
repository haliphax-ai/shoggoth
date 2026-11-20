// fs helper entry — persistent per-session helper process for fs mutations.
// Spawned by the daemon via procman (one per session, first fs op), running as
// the agent UID/GID so kernel DAC applies. NDJSON requests/responses on stdio.

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

/** Recursively count entries in a directory tree (the directory itself included). */
function countDir(dir) {
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
function doMove(params) {
  fs.mkdirSync(path.dirname(params.dst), { recursive: true });
  fs.renameSync(params.src, params.dst);
  return { ok: true };
}

/** fs copy: mkdir -p the destination parent, then recursive copy. */
function doCopy(params) {
  fs.mkdirSync(path.dirname(params.dst), { recursive: true });
  fs.cpSync(params.src, params.dst, { recursive: true });
  return { ok: true };
}

/** fs delete: refuse non-empty directories unless recursive; returns removed entry count. */
function doDelete(params) {
  const target = params.src;
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
function doStat(params) {
  const lst = fs.lstatSync(params.src);
  const isLink = lst.isSymbolicLink();
  const st = isLink ? fs.statSync(params.src) : lst;
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

/** fs chmod: apply an octal mode string to the target. */
function doChmod(params) {
  fs.chmodSync(params.src, parseInt(params.modeInt, 10));
  return { ok: true };
}

/** fs mkdir: succeed silently when the target already is a directory. */
function doMkdir(params) {
  const recursive = params.recursive === true;
  try {
    if (fs.statSync(params.src).isDirectory()) return { ok: true };
  } catch {
    // not there yet — create below
  }
  fs.mkdirSync(params.src, { recursive });
  return { ok: true };
}

const ACTIONS = {
  move: doMove,
  copy: doCopy,
  delete: doDelete,
  stat: doStat,
  chmod: doChmod,
  mkdir: doMkdir,
};

/** Execute one command object; never throws — failures come back as results. */
function execute(command) {
  const action = ACTIONS[command?.action];
  if (!action) {
    return { ok: false, error: `unknown action: ${String(command?.action)}` };
  }
  try {
    return action(command.params ?? {});
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let command;
  try {
    command = JSON.parse(trimmed);
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
