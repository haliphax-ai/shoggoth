/**
 * Diagnostics preload for CI: prints the exit status of every forked child.
 *
 * Vitest's own worker forks ignore the (code, signal) arguments of the child's
 * "exit" event when reporting an unexpected worker death, so a run that loses a
 * worker mid-file shows no reason in the log. This preload wraps
 * child_process.fork in the process that loads it and logs one plain,
 * greppable line per forked child exit:
 *
 *   [worker-exit-diag] pid=<pid> code=<code> signal=<signal>
 *
 * Loaded via NODE_OPTIONS in the CI step. It also loads inside test workers
 * and inside node children spawned by tests: it defines no output and no
 * top-level work of its own, is CommonJS with no dependencies, and adds an
 * "exit" listener only to children forked from that process (waiting only for
 * children that exit; it never extends the lifetime of exiting children).
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
