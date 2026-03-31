import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessManager } from "@shoggoth/procman";
import {
  toolExecExtended,
  setProcessManager,
  getProcessManager,
  getExecSession,
  getManagedExecSession,
  removeExecSession,
} from "../src/tools";
import { toolPoll } from "../src/poll";
import type {
  ExecForegroundResult,
  ExecBackgroundResult,
} from "../src/tools";
import type {
  PollCombinedResult,
  PollSplitResult,
  PollError,
} from "../src/poll";

describe("procman integration", () => {
  let ws: string;
  let pm: ProcessManager;
  const creds = { uid: process.getuid!(), gid: process.getgid!() };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-procman-exec-"));
    pm = new ProcessManager();
    setProcessManager(pm);
  });

  afterEach(async () => {
    await pm.stopAll();
    setProcessManager(undefined);
    rmSync(ws, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // setProcessManager / getProcessManager
  // -----------------------------------------------------------------------

  describe("setProcessManager / getProcessManager", () => {
    it("returns the set ProcessManager", () => {
      assert.strictEqual(getProcessManager(), pm);
    });

    it("returns undefined after clearing", () => {
      setProcessManager(undefined);
      assert.strictEqual(getProcessManager(), undefined);
      // Restore for afterEach cleanup
      setProcessManager(pm);
    });
  });

  // -----------------------------------------------------------------------
  // Background exec via procman
  // -----------------------------------------------------------------------

  describe("background exec via procman", () => {
    it("returns background result with sessionId and pid", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo hello-procman",
        background: true,
      }, creds);
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;
      assert.ok(bg.sessionId);
      assert.ok(bg.sessionId.startsWith("exec-"));
      assert.ok(bg.pid > 0);
      assert.equal(bg.status, "running");
    });

    it("process is tracked in ProcessManager, not legacy Map", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 0.2",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;

      // Should NOT be in the legacy Map
      const legacyHandle = getExecSession(bg.sessionId);
      assert.strictEqual(legacyHandle, undefined);

      // Should be in procman
      const mp = getManagedExecSession(bg.sessionId);
      assert.ok(mp, "process should be in ProcessManager");
      assert.equal(mp.pid, bg.pid);
    });

    it("process has correct owner metadata", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 0.2",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const mp = getManagedExecSession(bg.sessionId)!;
      assert.deepStrictEqual(mp.spec.owner, { kind: "agent-tool", scopeId: "exec" });
      assert.deepStrictEqual(mp.spec.restart, { mode: "never" });
    });

    it("captures output in procman ring buffer", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo procman-output",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const mp = getManagedExecSession(bg.sessionId)!;

      // Wait for process to finish
      await new Promise<void>((resolve) => {
        if (mp.state === "dead") { resolve(); return; }
        mp.on("state-change", (s: string) => { if (s === "dead") resolve(); });
      });

      const stdout = mp.readOutput("stdout");
      assert.ok(stdout.includes("procman-output"));
    });

    it("removeExecSession stops procman-managed process", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 10",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;

      const removed = removeExecSession(bg.sessionId);
      assert.equal(removed, true);

      // Give procman a moment to stop the process
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should no longer be in procman
      const mp = getManagedExecSession(bg.sessionId);
      assert.strictEqual(mp, undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Yield-based backgrounding via procman
  // -----------------------------------------------------------------------

  describe("yieldMs via procman", () => {
    it("returns foreground result when process finishes within yield window", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo fast-yield-pm",
        yieldMs: 5000,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.ok(fg.output?.includes("fast-yield-pm"));
      assert.equal(fg.exitCode, 0);
    });

    it("backgrounds process when it exceeds yield window", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 10; echo done",
        yieldMs: 200,
      }, creds);
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;
      assert.equal(bg.yielded, true);
      assert.ok(bg.sessionId);
      assert.ok(bg.pid > 0);

      // Should be in procman
      const mp = getManagedExecSession(bg.sessionId);
      assert.ok(mp);
    });

    it("includes partial output when yielded via procman", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo partial-pm; sleep 10",
        yieldMs: 500,
      }, creds);
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;
      assert.equal(bg.yielded, true);
      if (bg.partialOutput) {
        assert.ok(bg.partialOutput.includes("partial-pm"));
      }
    });

    it("yieldMs of 0 is equivalent to background: true", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 0.1",
        yieldMs: 0,
      }, creds);
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;
      assert.ok(getManagedExecSession(bg.sessionId));
    });
  });

  // -----------------------------------------------------------------------
  // Poll via procman
  // -----------------------------------------------------------------------

  describe("poll via procman", () => {
    it("returns running status for an active procman process", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 5",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;

      const poll = await toolPoll({ pid: bg.pid });
      assert.ok(!("error" in poll));
      const result = poll as PollCombinedResult;
      assert.equal(result.pid, bg.pid);
      assert.equal(result.status, "running");
      assert.ok(result.runtimeMs >= 0);
    });

    it("returns exited status with output for completed procman process", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo poll-pm-output",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const mp = getManagedExecSession(bg.sessionId)!;

      // Wait for process to finish
      await new Promise<void>((resolve) => {
        if (mp.state === "dead") { resolve(); return; }
        mp.on("state-change", (s: string) => { if (s === "dead") resolve(); });
      });

      const poll = await toolPoll({ pid: bg.pid });
      assert.ok(!("error" in poll));
      const result = poll as PollCombinedResult;
      assert.equal(result.status, "exited");
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes("poll-pm-output"));
      assert.ok(result.outputBytes > 0);
    });

    it("captures non-zero exit code via procman poll", async () => {
      const r = await toolExecExtended(ws, {
        command: "exit 7",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const mp = getManagedExecSession(bg.sessionId)!;

      await new Promise<void>((resolve) => {
        if (mp.state === "dead") { resolve(); return; }
        mp.on("state-change", (s: string) => { if (s === "dead") resolve(); });
      });

      const poll = await toolPoll({ pid: bg.pid });
      assert.ok(!("error" in poll));
      const result = poll as PollCombinedResult;
      assert.equal(result.status, "exited");
      assert.equal(result.exitCode, 7);
    });

    it("supports split streams via procman poll", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo out-pm; echo err-pm >&2",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const mp = getManagedExecSession(bg.sessionId)!;

      await new Promise<void>((resolve) => {
        if (mp.state === "dead") { resolve(); return; }
        mp.on("state-change", (s: string) => { if (s === "dead") resolve(); });
      });

      const poll = await toolPoll({ pid: bg.pid, streams: true });
      assert.ok(!("error" in poll));
      const result = poll as PollSplitResult;
      assert.ok(result.stdout.includes("out-pm"));
      assert.ok(result.stderr.includes("err-pm"));
    });

    it("supports tail filter via procman poll", async () => {
      const r = await toolExecExtended(ws, {
        command: "seq 1 50",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const mp = getManagedExecSession(bg.sessionId)!;

      await new Promise<void>((resolve) => {
        if (mp.state === "dead") { resolve(); return; }
        mp.on("state-change", (s: string) => { if (s === "dead") resolve(); });
      });

      const poll = await toolPoll({ pid: bg.pid, tail: 3 });
      assert.ok(!("error" in poll));
      const result = poll as PollCombinedResult;
      assert.ok(result.output.includes("50"));
      assert.equal(result.truncated, true);
    });

    it("supports since filter via procman poll", async () => {
      const r = await toolExecExtended(ws, {
        command: "printf 'AAABBBCCC'",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const mp = getManagedExecSession(bg.sessionId)!;

      await new Promise<void>((resolve) => {
        if (mp.state === "dead") { resolve(); return; }
        mp.on("state-change", (s: string) => { if (s === "dead") resolve(); });
      });

      const poll = await toolPoll({ pid: bg.pid, since: 3 });
      assert.ok(!("error" in poll));
      const result = poll as PollCombinedResult;
      assert.equal(result.output, "BBBCCC");
      assert.equal(result.outputBytes, 9);
      assert.equal(result.truncated, true);
    });

    it("supports timeout wait via procman poll", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo fast-pm",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;

      const poll = await toolPoll({ pid: bg.pid, timeout: 5000 });
      assert.ok(!("error" in poll));
      const result = poll as PollCombinedResult;
      assert.equal(result.status, "exited");
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes("fast-pm"));
      assert.equal(result.waited, true);
    });

    it("returns error for unknown PID when procman is set", async () => {
      const poll = await toolPoll({ pid: 999999 });
      assert.ok("error" in poll);
      assert.ok((poll as PollError).error.includes("999999"));
    });
  });

  // -----------------------------------------------------------------------
  // Foreground exec is unaffected by procman
  // -----------------------------------------------------------------------

  describe("foreground exec unaffected", () => {
    it("foreground exec does not go through procman", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo foreground-pm",
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.ok(fg.output?.includes("foreground-pm"));
      assert.equal(fg.exitCode, 0);

      // No processes should be in procman
      const managed = pm.listByOwner({ kind: "agent-tool", scopeId: "exec" });
      assert.equal(managed.length, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Fallback when ProcessManager is cleared
  // -----------------------------------------------------------------------

  describe("fallback without ProcessManager", () => {
    it("falls back to legacy Map when ProcessManager is cleared", async () => {
      setProcessManager(undefined);

      const r = await toolExecExtended(ws, {
        command: "sleep 0.2",
        background: true,
      }, creds);
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;

      // Should be in legacy Map
      const handle = getExecSession(bg.sessionId);
      assert.ok(handle);
      assert.equal(handle.pid, bg.pid);

      // Should NOT be in procman
      const mp = getManagedExecSession(bg.sessionId);
      assert.strictEqual(mp, undefined);

      await handle.done;
      removeExecSession(bg.sessionId);

      // Restore for afterEach
      setProcessManager(pm);
    });
  });
});
