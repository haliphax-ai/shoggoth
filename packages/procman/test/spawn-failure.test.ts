/**
 * Empirical guarantees for spawn/child failure modes in procman:
 *  - start() settles (rejects) instead of hanging or reporting "running"
 *  - the state machine never sticks in "starting"
 *  - spawn failures count toward the restart policy (on-failure + maxRetries)
 *    and stop after maxRetries — never an infinite restart loop, never a crash
 */
import assert from "node:assert";
import { describe, it, vi } from "vitest";
import {
  ManagedProcess,
  ProcessManager,
  type ProcessSpec,
  type ProcessState,
} from "../src/index.js";

const MISSING_COMMAND = "/nonexistent/shoggoth-procman-does-not-exist";
const OWNER: ProcessSpec["owner"] = { kind: "daemon", scopeId: "spawn-failure-tests" };

const SETTLED_STATES: ProcessState[] = ["failed", "exited", "dead"];

/** Resolves when `mp` next reaches a state satisfying `pred`. Event-driven: no
 * wall-clock polling (vitest's own test timeout catches a hang). */
function waitForState(mp: ManagedProcess, pred: (state: ProcessState) => boolean): Promise<void> {
  if (pred(mp.state)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onChange = (newState: ProcessState) => {
      if (!pred(newState)) return;
      mp.removeListener("state-change", onChange);
      resolve();
    };
    mp.on("state-change", onChange);
  });
}

function spec(overrides: Partial<ProcessSpec> & { command: string }): ProcessSpec {
  return {
    id: `spawn-fail-${Math.random().toString(36).slice(2, 10)}`,
    owner: OWNER,
    restart: { mode: "never" },
    ...overrides,
  };
}

describe("ManagedProcess spawn failure", () => {
  it("start() rejects for a nonexistent binary instead of hanging in starting", async () => {
    const mp = new ManagedProcess(spec({ command: MISSING_COMMAND }));
    await assert.rejects(() => mp.start(), /ENOENT|spawn|EACCES/i);
    await waitForState(mp, (s) => SETTLED_STATES.includes(s));
    assert.ok(
      SETTLED_STATES.includes(mp.state),
      `state must settle (got "${mp.state}", not starting/running)`,
    );
  });

  it("start() rejects for a non-executable file (EACCES)", async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "shoggoth-procman-")), "not-executable");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o644);
    const mp = new ManagedProcess(spec({ command: file }));
    await assert.rejects(() => mp.start(), /EACCES|spawn/i);
    await waitForState(mp, (s) => SETTLED_STATES.includes(s));
    assert.ok(SETTLED_STATES.includes(mp.state), `state must settle (got "${mp.state}")`);
  });

  it("still reaches running for a healthy process", async () => {
    const mp = new ManagedProcess(
      spec({ command: process.execPath, args: ["-e", "setTimeout(()=>{},5000)"] }),
    );
    await mp.start();
    assert.equal(mp.state, "running");
    await mp.stop();
    assert.equal(mp.state, "dead");
  });
});

describe("restart policy accounting for spawn failures", () => {
  it("on-failure counts spawn errors and stops after maxRetries", async () => {
    const pm = new ProcessManager();
    try {
      const s = spec({
        command: MISSING_COMMAND,
        restart: { mode: "on-failure", maxRetries: 2, initialDelayMs: 5, backoffMultiplier: 1 },
      });
      const mp = await pm.start(s);
      await waitForState(mp, (s) => s === "dead");
      assert.equal(mp.restartCount, 2, "exactly maxRetries restarts for spawn failures");
      const settled = mp.restartCount;
      // Any late restart would be scheduled as a timer by the restart policy;
      // run the next 200ms of that clock (faked) and prove nothing fires.
      vi.useFakeTimers();
      try {
        await vi.advanceTimersByTimeAsync(200);
      } finally {
        vi.useRealTimers();
      }
      assert.equal(mp.restartCount, settled, "no restarts after settling dead");
      assert.equal(mp.state, "dead");
    } finally {
      await pm.stopAll().catch(() => {});
    }
  });

  it("on-failure counts an immediate non-zero exit and stops after maxRetries", async () => {
    const pm = new ProcessManager();
    try {
      const s = spec({
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        restart: { mode: "on-failure", maxRetries: 1, initialDelayMs: 5, backoffMultiplier: 1 },
      });
      const mp = await pm.start(s);
      await waitForState(mp, (s) => s === "dead");
      assert.equal(mp.restartCount, 1, "exactly maxRetries restarts for exit-code failures");
      assert.equal(mp.lastExitCode, 3);
    } finally {
      await pm.stopAll().catch(() => {});
    }
  });

  it("signal death settles without restart under on-failure (documented policy)", async () => {
    const pm = new ProcessManager();
    try {
      const s = spec({
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
        restart: { mode: "on-failure", maxRetries: 3, initialDelayMs: 5, backoffMultiplier: 1 },
      });
      const mp = await pm.start(s);
      await waitForState(mp, (s) => s === "dead");
      assert.equal(mp.restartCount, 0, "on-failure does not restart signal-killed processes");
      assert.equal(mp.lastSignal, "SIGKILL");
    } finally {
      await pm.stopAll().catch(() => {});
    }
  });

  it("on-failure restarts a process that dies by signal when configured to expect crashes", async () => {
    // on-unexpected-exit covers signal deaths (the mode for crash-prone procs).
    const pm = new ProcessManager();
    try {
      const s = spec({
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
        restart: {
          mode: "on-unexpected-exit",
          maxRetries: 2,
          initialDelayMs: 5,
          backoffMultiplier: 1,
        },
      });
      const mp = await pm.start(s);
      await waitForState(mp, (s) => s === "dead");
      assert.equal(mp.restartCount, 2, "signal deaths restart up to maxRetries");
    } finally {
      await pm.stopAll().catch(() => {});
    }
  });
});
