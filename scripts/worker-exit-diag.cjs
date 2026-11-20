/**
 * Diagnostics preload for CI (loaded via NODE_OPTIONS in the CI step): wraps
 * child_process.fork to print one greppable line per forked child exit:
 *   [worker-exit-diag] pid=<pid> code=<code> signal=<signal>
 * Why it exists: docs/cli.md — "Worker exit diagnostics preload".
 */
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");

const realFork = cp.fork;

cp.fork = function patchedFork(...forkArgs) {
  const child = realFork.apply(this, forkArgs);
  child.on("exit", (code, signal) => {
    if (code === null && signal === null) return;
    const line = `[worker-exit-diag] pid=${String(child.pid)} code=${String(code)} signal=${String(signal)}\n`;
    // Write synchronously: the process may be tearing down on exit, and an
    // async stdout write to a pipe could be dropped before it flushes.
    try {
      fs.writeSync(1, line);
    } catch {
      /* stdout unavailable; diagnostics are best-effort only */
    }
  });
  return child;
};
