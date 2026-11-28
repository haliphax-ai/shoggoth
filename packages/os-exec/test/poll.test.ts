import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessManager, ManagedProcess } from "@shoggoth/procman";
import type { ProcessSpec } from "@shoggoth/procman";
import {
  toolExecExtended,
  getManagedExecSession,
  removeExecSession,
  setProcessManager,
} from "../src/tools";
import { toolPoll } from "../src/poll";
import type { PollCombinedResult, PollSplitResult, PollError } from "../src/poll";
import type { ExecBackgroundResult } from "../src/tools";

describe("toolPoll", () => {
  let ws: string;
  let pm: ProcessManager;
  const creds = { uid: process.getuid!(), gid: process.getgid!() };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-poll-"));
    pm = new ProcessManager();
    setProcessManager(pm);
  });

  afterEach(async () => {
    await pm.stopAll();
    setProcessManager(undefined);
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  /** Helper: spawn a background process and return its PID + sessionId. */
  async function spawnBg(
    command: string,
    opts?: { yieldMs?: number },
  ): Promise<{ pid: number; sessionId: string }> {
    const r = await toolExecExtended(
      ws,
      {
        command,
        background: opts?.yieldMs === undefined ? true : undefined,
        yieldMs: opts?.yieldMs,
      },
      creds,
    );
    assert.equal(r.kind, "background");
    const bg = r as ExecBackgroundResult;
    return { pid: bg.pid, sessionId: bg.sessionId };
  }

  /** Helper: wait for a process to exit, then clean up. */
  async function cleanup(sessionId: string): Promise<void> {
    const mp = getManagedExecSession(sessionId);
    if (mp) {
      if (!["exited", "dead", "failed"].includes(mp.state)) {
        mp.kill();
        await new Promise<void>((resolve) => {
          if (["exited", "dead", "failed"].includes(mp.state)) {
            resolve();
            return;
          }
          mp.on("state-change", (s: string) => {
            if (["exited", "dead", "failed"].includes(s)) resolve();
          });
        });
      }
      await removeExecSession(sessionId);
    }
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe("validation", () => {
    it("rejects missing pid", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await assert.rejects(() => toolPoll({} as any), /pid.*required/i);
    });

    it("rejects non-integer pid", async () => {
      await assert.rejects(() => toolPoll({ pid: 1.5 }), /pid.*positive integer/i);
    });

    it("rejects negative pid", async () => {
      await assert.rejects(() => toolPoll({ pid: -1 }), /pid.*positive integer/i);
    });

    it("rejects zero pid", async () => {
      await assert.rejects(() => toolPoll({ pid: 0 }), /pid.*positive integer/i);
    });

    it("rejects negative timeout", async () => {
      await assert.rejects(() => toolPoll({ pid: 1, timeout: -1 }), /timeout.*non-negative/i);
    });

    it("rejects non-integer tail", async () => {
      await assert.rejects(() => toolPoll({ pid: 1, tail: 1.5 }), /tail.*positive integer/i);
    });

    it("rejects zero tail", async () => {
      await assert.rejects(() => toolPoll({ pid: 1, tail: 0 }), /tail.*positive integer/i);
    });

    it("rejects negative since", async () => {
      await assert.rejects(() => toolPoll({ pid: 1, since: -1 }), /since.*non-negative/i);
    });
  });

  // -----------------------------------------------------------------------
  // Unknown PID
  // -----------------------------------------------------------------------

  describe("unknown PID", () => {
    it("returns error for untracked PID", async () => {
      const r = await toolPoll({ pid: 999999 });
      assert.ok("error" in r);
      assert.ok((r as PollError).error.includes("no tracked process with pid 999999"));
    });
  });

  // -----------------------------------------------------------------------
  // Basic status check
  // -----------------------------------------------------------------------

  describe("basic status check", () => {
    it("returns running status for an active process", async () => {
      const { pid, sessionId } = await spawnBg("sleep 5");
      try {
        const r = await toolPoll({ pid });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.pid, pid);
        assert.equal(result.status, "running");
        assert.ok(result.runtimeMs >= 0);
        assert.equal(result.exitCode, undefined);
      } finally {
        await cleanup(sessionId);
      }
    });

    it("returns exited status with exit code for a completed process", async () => {
      const { pid, sessionId } = await spawnBg("echo done");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.pid, pid);
        assert.equal(result.status, "exited");
        assert.equal(result.exitCode, 0);
        assert.ok(result.output.includes("done"));
        assert.ok(result.outputBytes > 0);
      } finally {
        await removeExecSession(sessionId);
      }
    });

    it("captures non-zero exit code", async () => {
      const { pid, sessionId } = await spawnBg("exit 42");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.status, "exited");
        assert.equal(result.exitCode, 42);
      } finally {
        await removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // timeout — wait for completion
  // -----------------------------------------------------------------------

  describe("timeout", () => {
    it("returns immediately when timeout is 0 (default)", async () => {
      const { pid, sessionId } = await spawnBg("sleep 5");
      try {
        const start = Date.now();
        const r = await toolPoll({ pid, timeout: 0 });
        const elapsed = Date.now() - start;
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.status, "running");
        assert.equal(result.waited, undefined);
        // Should return nearly instantly
        assert.ok(elapsed < 1000);
      } finally {
        await cleanup(sessionId);
      }
    });

    it("waits and returns completed result when process finishes within timeout", async () => {
      const { pid, sessionId } = await spawnBg("echo fast-finish");
      try {
        const r = await toolPoll({ pid, timeout: 5000 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.status, "exited");
        assert.equal(result.exitCode, 0);
        assert.ok(result.output.includes("fast-finish"));
        // Process exited during the wait — that is not a "waited out the
        // timeout" result.
        assert.equal(result.waited, undefined);
        assert.equal(result.waitedMs, undefined);
      } finally {
        await removeExecSession(sessionId);
      }
    });

    it("returns running status after timeout expires", async () => {
      const { pid, sessionId } = await spawnBg("sleep 5");
      try {
        const r = await toolPoll({ pid, timeout: 200 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.status, "running");
        assert.equal(result.waited, true);
        assert.ok(result.waitedMs! >= 150); // allow some clock skew around the 200ms window
      } finally {
        await cleanup(sessionId);
      }
    });

    it("returns immediately for already-exited process regardless of timeout", async () => {
      const { pid, sessionId } = await spawnBg("echo already-done");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const start = Date.now();
        const r = await toolPoll({ pid, timeout: 5000 });
        const elapsed = Date.now() - start;
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.status, "exited");
        // Should not have waited the full 5s
        assert.ok(elapsed < 1000);
        // An already-exited process returns instantly — `waited` must be
        // omitted so callers can tell "blocked for the window" from "returned
        // right away".
        assert.equal(result.waited, undefined);
        assert.equal(result.waitedMs, undefined);
      } finally {
        await removeExecSession(sessionId);
      }
    });
    it("clears the timeout timer when the process exits during the wait", async () => {
      const { pid, sessionId } = await spawnBg("sleep 5");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (mp.state === "running") {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (s === "running") resolve();
        });
      });

      // Fake clock starts at zero pending timers. The kill makes the
      // state-change path win the race; a leaked timer would still be
      // counted on the fake clock.
      vi.useFakeTimers();
      try {
        const pending = toolPoll({ pid, timeout: 60000 });
        mp.kill();
        const r = await pending;
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.status, "exited");
        assert.equal(result.waited, undefined);
        assert.equal(result.waitedMs, undefined);
        assert.equal(vi.getTimerCount(), 0);
      } finally {
        vi.useRealTimers();
        await cleanup(sessionId);
      }
    });

    it("clears the timeout timer when the timeout expires", async () => {
      const { pid, sessionId } = await spawnBg("sleep 5");
      try {
        // Real timers for spawn setup (procman schedules its own timers);
        // fake clock for the poll's timeout window.
        vi.useFakeTimers();
        try {
          const pending = toolPoll({ pid, timeout: 2000 });
          // Progress the fake clock until the poll's own timeout fires; a
          // leaked timer would still be counted on the fake clock.
          await vi.advanceTimersByTimeAsync(2000);
          const r = await pending;
          assert.ok(!("error" in r));
          const result = r as PollCombinedResult;
          assert.equal(result.status, "running");
          assert.equal(result.waited, true);
          assert.equal(vi.getTimerCount(), 0);
        } finally {
          vi.useRealTimers();
        }
      } finally {
        await cleanup(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // streams — split stdout/stderr
  // -----------------------------------------------------------------------

  describe("streams", () => {
    it("returns combined output by default", async () => {
      const { pid, sessionId } = await spawnBg("echo out; echo err >&2");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.ok("output" in result);
        assert.ok("outputBytes" in result);
        assert.ok(!("stdout" in result));
        assert.ok(!("stderr" in result));
      } finally {
        await removeExecSession(sessionId);
      }
    });

    it("returns split stdout/stderr when streams is true", async () => {
      const { pid, sessionId } = await spawnBg("echo out-data; echo err-data >&2");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid, streams: true });
        assert.ok(!("error" in r));
        const result = r as PollSplitResult;
        assert.ok(result.stdout.includes("out-data"));
        assert.ok(result.stderr.includes("err-data"));
        assert.ok(result.stdoutBytes > 0);
        assert.ok(result.stderrBytes > 0);
        assert.ok(!("output" in result));
      } finally {
        await removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // tail — last N lines
  // -----------------------------------------------------------------------

  describe("tail", () => {
    it("returns only the last N lines of output", async () => {
      const { pid, sessionId } = await spawnBg("seq 1 100");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid, tail: 3 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        const lines = result.output.split("\n").filter((l) => l.length > 0);
        // Last 3 lines of seq 1 100 should be 98, 99, 100
        assert.ok(lines.length <= 3);
        assert.ok(result.output.includes("100"));
        assert.equal(result.truncated, true);
      } finally {
        await removeExecSession(sessionId);
      }
    });

    it("returns all output when tail exceeds line count", async () => {
      const { pid, sessionId } = await spawnBg("echo one; echo two");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid, tail: 1000 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.ok(result.output.includes("one"));
        assert.ok(result.output.includes("two"));
        assert.equal(result.truncated, false);
      } finally {
        await removeExecSession(sessionId);
      }
    });

    it("works with streams: true", async () => {
      const { pid, sessionId } = await spawnBg("seq 1 50; seq 51 100 >&2");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid, streams: true, tail: 2 });
        assert.ok(!("error" in r));
        const result = r as PollSplitResult;
        // stdout tail should have lines from seq 1 50
        assert.ok(result.stdout.includes("50"));
        // stderr tail should have lines from seq 51 100
        assert.ok(result.stderr.includes("100"));
      } finally {
        await removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // since — incremental reads
  // -----------------------------------------------------------------------

  describe("since", () => {
    it("returns output after the byte offset", async () => {
      const { pid, sessionId } = await spawnBg("printf 'AAABBBCCC'");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid, since: 3 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.output, "BBBCCC");
        assert.equal(result.outputBytes, 9); // total bytes
        assert.equal(result.truncated, true); // since > 0 means truncated
      } finally {
        await removeExecSession(sessionId);
      }
    });

    it("returns empty output when since exceeds current byte count", async () => {
      const { pid, sessionId } = await spawnBg("echo short");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid, since: 99999 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.output, "");
        // outputBytes tells the agent the current total
        assert.ok(result.outputBytes > 0);
      } finally {
        await removeExecSession(sessionId);
      }
    });

    it("returns all output when since is 0", async () => {
      const { pid, sessionId } = await spawnBg("echo all-data");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid, since: 0 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.ok(result.output.includes("all-data"));
        assert.equal(result.truncated, false); // since=0 means no truncation
      } finally {
        await removeExecSession(sessionId);
      }
    });

    it("works with streams: true", async () => {
      const { pid, sessionId } = await spawnBg("printf 'STDOUT'; printf 'STDERR' >&2");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        const r = await toolPoll({ pid, streams: true, since: 2 });
        assert.ok(!("error" in r));
        const result = r as PollSplitResult;
        assert.equal(result.stdout, "DOUT");
        assert.equal(result.stderr, "DERR");
      } finally {
        await removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // tail takes precedence over since
  // -----------------------------------------------------------------------

  describe("tail + since interaction", () => {
    it("tail takes precedence over since", async () => {
      const { pid, sessionId } = await spawnBg("seq 1 10");
      const mp = getManagedExecSession(sessionId)!;
      await new Promise<void>((resolve) => {
        if (["exited", "dead", "failed"].includes(mp.state)) {
          resolve();
          return;
        }
        mp.on("state-change", (s: string) => {
          if (["exited", "dead", "failed"].includes(s)) resolve();
        });
      });

      try {
        // When both are set, tail wins
        const r = await toolPoll({ pid, tail: 2, since: 0 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        const lines = result.output.split("\n").filter((l) => l.length > 0);
        assert.ok(lines.length <= 2);
        assert.ok(result.output.includes("10"));
      } finally {
        await removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Yielded processes
  // -----------------------------------------------------------------------

  describe("yielded processes", () => {
    it("can poll a process that was backgrounded via yieldMs", async () => {
      const { pid, sessionId } = await spawnBg("echo yielded-output; sleep 2", {
        yieldMs: 200,
      });
      try {
        const r = await toolPoll({ pid });
        assert.ok(!("error" in r));
        assert.equal(r.pid, pid);
        // Could be running or exited depending on timing
        assert.ok(r.status === "running" || r.status === "exited");
      } finally {
        await cleanup(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // runtimeMs
  // -----------------------------------------------------------------------

  describe("runtimeMs", () => {
    it("returns a reasonable runtime estimate", async () => {
      vi.useFakeTimers();
      try {
        // _startedAt is captured under the fake clock; advancing it makes the
        // uptime estimate deterministic instead of sleeping in real time.
        const { pid, sessionId } = await spawnBg("sleep 2");
        try {
          await vi.advanceTimersByTimeAsync(100);
          const r = await toolPoll({ pid });
          assert.ok(!("error" in r));
          const result = r as PollCombinedResult;
          assert.ok(result.runtimeMs >= 50); // at least ~50ms
          assert.ok(result.runtimeMs < 30000); // sanity upper bound
        } finally {
          await cleanup(sessionId);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -----------------------------------------------------------------------
  // PID reuse — recency tiebreak
  // -----------------------------------------------------------------------

  describe("PID reuse tiebreak", () => {
    /** Real spec id of the one live base session (for teardown). */
    let baseId: string;
    let cloneIds: string[] = [];

    /**
     * Register thin stand-ins sharing the base session's PID, each carrying
     * its own spec. findProcessByPid compares only spec.id and pid, so
     * duplicated EventEmitters (and the `_pid` name-mangling workaround they
     * would need) are unnecessary; state and output stay with the real
     * ManagedProcess that the winner resolves to.
     */
    function registerSpecClones(ids: string[]): void {
      const base = pm.listByOwner({ kind: "agent-tool", scopeId: "exec" })[0];
      if (!base) throw new Error("no managed session registered");

      for (const id of ids) {
        const spec: ProcessSpec = {
          id,
          owner: { kind: "agent-tool", scopeId: "exec" },
          command: base.spec.command,
          args: base.spec.args,
          cwd: base.spec.cwd,
          uid: base.spec.uid,
          gid: base.spec.gid,
          env: base.spec.env,
          restart: { mode: "never" },
          stdio: { capture: "pipe", stdin: false },
        };
        // Construction does not spawn; real procman tests register bare
        // instances the same way. `_pid` and `processes` are private.
        const mp = new ManagedProcess(spec);
        (mp as unknown as { _pid: number })._pid = base.pid;
        (pm as unknown as { processes: Map<string, ManagedProcess> }).processes.set(id, mp);
        cloneIds.push(id);
      }
    }

    /**
     * Rewrite the real session's spec ID to a known sequence so test outcomes
     * do not depend on the module-level counter's value at test time.
     */
    function resequenceBase(id: string): void {
      const base = pm.listByOwner({ kind: "agent-tool", scopeId: "exec" })[0];
      if (!base) throw new Error("no managed session registered");
      const spec = { ...base.spec, id } as ProcessSpec;
      const reid = base as unknown as { spec: ProcessSpec };
      reid.spec = spec;
    }

    beforeEach(() => {
      baseId = "";
      cloneIds = [];
    });

    afterEach(async () => {
      // Bare clones were never started; deregister them directly so the
      // outer stopAll only handles the real spawned process.
      const map = (pm as unknown as { processes: Map<string, ManagedProcess> }).processes;
      for (const id of cloneIds) map.delete(id);
      cloneIds = [];
      if (baseId) {
        const mp = map.get(baseId);
        if (mp && mp.state !== "dead") await mp.kill();
      }
    });

    it("prefers the newest sequenced session among clones sharing a PID", async () => {
      const { pid, sessionId } = await spawnBg("echo NEWEST-OUTPUT; sleep 5");
      baseId = sessionId;
      resequenceBase("exec-0000000010-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      registerSpecClones([
        "exec-0000000011-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "exec-0000000012-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "exec-0000000013-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ]);

      const r = await toolPoll({ pid });
      assert.ok(!("error" in r));
      // The newest clone wins, so the real session's output must not show up.
      assert.equal(r.output.includes("NEWEST-OUTPUT"), false);
      // The winner is a bare clone (never started).
      assert.equal(r.runtimeMs, 0);
      assert.equal(r.status, "running");
    });

    it("orders clones by embedded sequence, not lexicographic id", async () => {
      const { pid, sessionId } = await spawnBg("echo NEWEST-OUTPUT; sleep 5");
      baseId = sessionId;
      resequenceBase("exec-0000000020-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      registerSpecClones([
        "exec-0000000021-zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
        "exec-0000000022-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "exec-0000000023-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ]);

      const r = await toolPoll({ pid });
      assert.ok(!("error" in r));
      // The sequence-newest clone wins, so the real session's output must
      // not show up.
      assert.equal(r.output.includes("NEWEST-OUTPUT"), false);
      // The winner is a bare clone (never started).
      assert.equal(r.runtimeMs, 0);
      assert.equal(r.status, "running");
    });

    it("resolves to the real session when it is the newest", async () => {
      const { pid, sessionId } = await spawnBg("echo NEWEST-OUTPUT; sleep 5");
      baseId = sessionId;
      resequenceBase("exec-0000000030-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      registerSpecClones([
        "exec-0000000028-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "exec-0000000029-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ]);

      const r = await toolPoll({ pid, timeout: 2000 });
      assert.ok(!("error" in r));
      assert.equal(r.output.includes("NEWEST-OUTPUT"), true);
      assert.equal(r.runtimeMs > 0, true);
    });

    it("prefers sequenced specs over lexicographically larger unsequenced ids", async () => {
      const { pid, sessionId } = await spawnBg("echo NEWEST-OUTPUT; sleep 5");
      baseId = sessionId;
      resequenceBase("exec-0000000040-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      // "ffffffff" sorts above any zero-padded sequence but parses to -1.
      registerSpecClones(["exec-ffffffff-ffff-4fff-8fff-ffffffffffff"]);

      const r = await toolPoll({ pid, timeout: 2000 });
      assert.ok(!("error" in r));
      assert.equal(r.output.includes("NEWEST-OUTPUT"), true);
      assert.equal(r.runtimeMs > 0, true);
    });

    it("breaks equal sequences by lexicographic spec id", async () => {
      const { pid, sessionId } = await spawnBg("echo NEWEST-OUTPUT; sleep 5");
      baseId = sessionId;
      resequenceBase("exec-0000000050-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      registerSpecClones(["exec-0000000050-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]);

      const r = await toolPoll({ pid });
      assert.ok(!("error" in r));
      // Equal sequences: the lexicographically larger id wins, so the real
      // session's output must not show up.
      assert.equal(r.output.includes("NEWEST-OUTPUT"), false);
      assert.equal(r.runtimeMs, 0);
      assert.equal(r.status, "running");
    });
  });
});
