import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolExecExtended, getExecSession, removeExecSession } from "../src/tools";
import { toolPoll } from "../src/poll";
import type { PollCombinedResult, PollSplitResult, PollError } from "../src/poll";
import type { ExecBackgroundResult } from "../src/tools";

describe("toolPoll", () => {
  let ws: string;
  const creds = { uid: process.getuid!(), gid: process.getgid!() };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-poll-"));
  });

  afterEach(() => {
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

  /** Helper: kill a background process group and clean up the session. */
  async function cleanup(sessionId: string): Promise<void> {
    const session = getExecSession(sessionId);
    if (session) {
      if (!session.exited) {
        // Kill the entire process group (detached processes need -pid)
        try {
          process.kill(-session.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
        await session.done;
      }
      removeExecSession(sessionId);
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
      const session = getExecSession(sessionId)!;
      await session.done;

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
        removeExecSession(sessionId);
      }
    });

    it("captures non-zero exit code", async () => {
      const { pid, sessionId } = await spawnBg("exit 42");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const r = await toolPoll({ pid });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.status, "exited");
        assert.equal(result.exitCode, 42);
      } finally {
        removeExecSession(sessionId);
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
        assert.equal(result.waited, true);
        assert.ok(typeof result.waitedMs === "number");
      } finally {
        removeExecSession(sessionId);
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
        assert.ok(result.waitedMs! >= 150); // allow some timing slack
      } finally {
        await cleanup(sessionId);
      }
    });

    it("returns immediately for already-exited process regardless of timeout", async () => {
      const { pid, sessionId } = await spawnBg("echo already-done");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const start = Date.now();
        const r = await toolPoll({ pid, timeout: 5000 });
        const elapsed = Date.now() - start;
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.status, "exited");
        // Should not have waited the full 5s
        assert.ok(elapsed < 1000);
      } finally {
        removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // streams — split stdout/stderr
  // -----------------------------------------------------------------------

  describe("streams", () => {
    it("returns combined output by default", async () => {
      const { pid, sessionId } = await spawnBg("echo out; echo err >&2");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const r = await toolPoll({ pid });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.ok("output" in result);
        assert.ok("outputBytes" in result);
        assert.ok(!("stdout" in result));
        assert.ok(!("stderr" in result));
      } finally {
        removeExecSession(sessionId);
      }
    });

    it("returns split stdout/stderr when streams is true", async () => {
      const { pid, sessionId } = await spawnBg("echo out-data; echo err-data >&2");
      const session = getExecSession(sessionId)!;
      await session.done;

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
        removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // tail — last N lines
  // -----------------------------------------------------------------------

  describe("tail", () => {
    it("returns only the last N lines of output", async () => {
      const { pid, sessionId } = await spawnBg("seq 1 100");
      const session = getExecSession(sessionId)!;
      await session.done;

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
        removeExecSession(sessionId);
      }
    });

    it("returns all output when tail exceeds line count", async () => {
      const { pid, sessionId } = await spawnBg("echo one; echo two");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const r = await toolPoll({ pid, tail: 1000 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.ok(result.output.includes("one"));
        assert.ok(result.output.includes("two"));
        assert.equal(result.truncated, false);
      } finally {
        removeExecSession(sessionId);
      }
    });

    it("works with streams: true", async () => {
      const { pid, sessionId } = await spawnBg("seq 1 50; seq 51 100 >&2");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const r = await toolPoll({ pid, streams: true, tail: 2 });
        assert.ok(!("error" in r));
        const result = r as PollSplitResult;
        // stdout tail should have lines from seq 1 50
        assert.ok(result.stdout.includes("50"));
        // stderr tail should have lines from seq 51 100
        assert.ok(result.stderr.includes("100"));
      } finally {
        removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // since — incremental reads
  // -----------------------------------------------------------------------

  describe("since", () => {
    it("returns output after the byte offset", async () => {
      const { pid, sessionId } = await spawnBg("printf 'AAABBBCCC'");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const r = await toolPoll({ pid, since: 3 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.output, "BBBCCC");
        assert.equal(result.outputBytes, 9); // total bytes
        assert.equal(result.truncated, true); // since > 0 means truncated
      } finally {
        removeExecSession(sessionId);
      }
    });

    it("returns empty output when since exceeds current byte count", async () => {
      const { pid, sessionId } = await spawnBg("echo short");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const r = await toolPoll({ pid, since: 99999 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.equal(result.output, "");
        // outputBytes tells the agent the current total
        assert.ok(result.outputBytes > 0);
      } finally {
        removeExecSession(sessionId);
      }
    });

    it("returns all output when since is 0", async () => {
      const { pid, sessionId } = await spawnBg("echo all-data");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const r = await toolPoll({ pid, since: 0 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.ok(result.output.includes("all-data"));
        assert.equal(result.truncated, false); // since=0 means no truncation
      } finally {
        removeExecSession(sessionId);
      }
    });

    it("works with streams: true", async () => {
      const { pid, sessionId } = await spawnBg("printf 'STDOUT'; printf 'STDERR' >&2");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        const r = await toolPoll({ pid, streams: true, since: 2 });
        assert.ok(!("error" in r));
        const result = r as PollSplitResult;
        assert.equal(result.stdout, "DOUT");
        assert.equal(result.stderr, "DERR");
      } finally {
        removeExecSession(sessionId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // tail takes precedence over since
  // -----------------------------------------------------------------------

  describe("tail + since interaction", () => {
    it("tail takes precedence over since", async () => {
      const { pid, sessionId } = await spawnBg("seq 1 10");
      const session = getExecSession(sessionId)!;
      await session.done;

      try {
        // When both are set, tail wins
        const r = await toolPoll({ pid, tail: 2, since: 0 });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        const lines = result.output.split("\n").filter((l) => l.length > 0);
        assert.ok(lines.length <= 2);
        assert.ok(result.output.includes("10"));
      } finally {
        removeExecSession(sessionId);
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
      const { pid, sessionId } = await spawnBg("sleep 2");
      try {
        // Small delay to ensure measurable runtime
        await new Promise((resolve) => setTimeout(resolve, 100));
        const r = await toolPoll({ pid });
        assert.ok(!("error" in r));
        const result = r as PollCombinedResult;
        assert.ok(result.runtimeMs >= 50); // at least ~50ms
        assert.ok(result.runtimeMs < 30000); // sanity upper bound
      } finally {
        await cleanup(sessionId);
      }
    });
  });
});
