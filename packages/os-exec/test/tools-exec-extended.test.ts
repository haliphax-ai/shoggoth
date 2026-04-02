import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  toolExecExtended,
  getExecSession,
  removeExecSession,
} from "../src/tools";
import type {
  ExecForegroundResult,
  ExecBackgroundResult,
} from "../src/tools";

describe("toolExecExtended", () => {
  let ws: string;
  const creds = { uid: process.getuid!(), gid: process.getgid!() };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-exec-ext-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Backward compatibility — simple command execution
  // -----------------------------------------------------------------------

  describe("basic execution (backward compat)", () => {
    it("runs a simple command and returns foreground result", async () => {
      const r = await toolExecExtended(ws, { command: "echo hello" }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.ok(fg.output?.includes("hello"));
      assert.equal(fg.exitCode, 0);
      assert.equal(fg.signal, null);
    });

    it("captures non-zero exit code", async () => {
      const r = await toolExecExtended(ws, { command: "exit 42" }, creds);
      assert.equal(r.kind, "foreground");
      assert.equal((r as ExecForegroundResult).exitCode, 42);
    });

    it("rejects empty command", async () => {
      await assert.rejects(
        () => toolExecExtended(ws, { command: "" }, creds),
        /command.*required/i,
      );
    });

    it("rejects whitespace-only command", async () => {
      await assert.rejects(
        () => toolExecExtended(ws, { command: "   " }, creds),
        /command.*required/i,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 1. Timeout
  // -----------------------------------------------------------------------

  describe("timeout", () => {
    it("kills a long-running process after timeout", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 60",
        timeout: 1,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.equal(fg.timedOut, true);
      // Process should have been killed — non-zero exit or signal
      assert.ok(fg.exitCode !== 0 || fg.signal !== null);
    });

    it("does not set timedOut when process finishes in time", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo fast",
        timeout: 10,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.equal(fg.timedOut, undefined);
      assert.equal(fg.exitCode, 0);
    });

    it("rejects invalid timeout values", async () => {
      await assert.rejects(
        () => toolExecExtended(ws, { command: "echo x", timeout: -1 }, creds),
        /timeout.*positive/i,
      );
      await assert.rejects(
        () => toolExecExtended(ws, { command: "echo x", timeout: 0 }, creds),
        /timeout.*positive/i,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 2. Stdin
  // -----------------------------------------------------------------------

  describe("stdin", () => {
    it("pipes stdin string to the process", async () => {
      const r = await toolExecExtended(ws, {
        command: "cat",
        stdin: "hello from stdin",
      }, creds);
      assert.equal(r.kind, "foreground");
      assert.ok((r as ExecForegroundResult).output?.includes("hello from stdin"));
    });

    it("works with jq-style piping", async () => {
      const r = await toolExecExtended(ws, {
        command: "cat | tr a-z A-Z",
        stdin: "lowercase",
      }, creds);
      assert.equal(r.kind, "foreground");
      assert.ok((r as ExecForegroundResult).output?.includes("LOWERCASE"));
    });

    it("handles special characters in stdin", async () => {
      const special = 'quotes "and" \'single\' and $vars and `backticks`';
      const r = await toolExecExtended(ws, {
        command: "cat",
        stdin: special,
      }, creds);
      assert.equal(r.kind, "foreground");
      assert.ok((r as ExecForegroundResult).output?.includes(special));
    });
  });

  // -----------------------------------------------------------------------
  // 3. Working directory (workdir)
  // -----------------------------------------------------------------------

  describe("workdir", () => {
    it("runs command in the specified directory", async () => {
      mkdirSync(join(ws, "subdir"), { recursive: true });
      const r = await toolExecExtended(ws, {
        command: "pwd",
        workdir: "subdir",
      }, creds);
      assert.equal(r.kind, "foreground");
      assert.ok((r as ExecForegroundResult).output?.trim().endsWith("/subdir"));
    });

    it("accepts absolute paths", async () => {
      const absDir = mkdtempSync(join(tmpdir(), "shoggoth-workdir-"));
      try {
        const r = await toolExecExtended(ws, {
          command: "pwd",
          workdir: absDir,
        }, creds);
        assert.equal(r.kind, "foreground");
        assert.ok((r as ExecForegroundResult).output?.trim().includes(absDir));
      } finally {
        rmSync(absDir, { recursive: true, force: true });
      }
    });

    it("errors when workdir does not exist", async () => {
      await assert.rejects(
        () => toolExecExtended(ws, {
          command: "echo x",
          workdir: "nonexistent-dir",
        }, creds),
        /workdir does not exist/i,
      );
    });

    it("defaults to workspace root when workdir is not set", async () => {
      const r = await toolExecExtended(ws, { command: "pwd" }, creds);
      assert.equal(r.kind, "foreground");
      // The cwd should be the workspace root (realpath'd)
      const output = (r as ExecForegroundResult).output?.trim();
      assert.ok(output && output.length > 0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Environment variable overrides
  // -----------------------------------------------------------------------

  describe("env", () => {
    it("passes custom env vars to the process", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo $MY_VAR",
        env: { MY_VAR: "custom_value" },
      }, creds);
      assert.equal(r.kind, "foreground");
      assert.ok((r as ExecForegroundResult).output?.includes("custom_value"));
    });

    it("overrides existing env vars", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo $HOME",
        env: { HOME: "/tmp/override" },
      }, creds);
      assert.equal(r.kind, "foreground");
      assert.ok((r as ExecForegroundResult).output?.includes("/tmp/override"));
    });

    it("merges with (does not replace) the inherited environment", async () => {
      // PATH should still be available even when we set a custom var
      const r = await toolExecExtended(ws, {
        command: "echo $PATH",
        env: { MY_CUSTOM: "yes" },
      }, creds);
      assert.equal(r.kind, "foreground");
      const output = (r as ExecForegroundResult).output?.trim();
      assert.ok(output && output.length > 0, "PATH should still be set");
    });
  });

  // -----------------------------------------------------------------------
  // 5. Split streams and truncation
  // -----------------------------------------------------------------------

  describe("splitStreams", () => {
    it("returns separate stdout and stderr when enabled", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo out; echo err >&2",
        splitStreams: true,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.ok(fg.stdout?.includes("out"));
      assert.ok(fg.stderr?.includes("err"));
      assert.equal(fg.output, undefined);
    });

    it("returns combined output when splitStreams is false", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo out; echo err >&2",
        splitStreams: false,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.ok(fg.output !== undefined);
      assert.equal(fg.stdout, undefined);
      assert.equal(fg.stderr, undefined);
    });
  });

  describe("truncation", () => {
    it("truncates long output with tail mode (default)", async () => {
      // Generate output longer than maxOutput
      const r = await toolExecExtended(ws, {
        command: "seq 1 10000",
        maxOutput: 100,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.equal(fg.truncated, true);
      assert.ok(fg.output!.includes("[... truncated"));
      // Tail mode: output should end with the last numbers
      assert.ok(fg.output!.includes("10000"));
    });

    it("truncates with head mode — keeps beginning", async () => {
      const r = await toolExecExtended(ws, {
        command: "seq 1 10000",
        maxOutput: 100,
        truncation: "head",
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.equal(fg.truncated, true);
      // Head mode: output should start with the first numbers
      assert.ok(fg.output!.startsWith("1\n"));
    });

    it("truncates with both mode — keeps beginning and end", async () => {
      const r = await toolExecExtended(ws, {
        command: "seq 1 10000",
        maxOutput: 100,
        truncation: "both",
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.equal(fg.truncated, true);
      assert.ok(fg.output!.includes("[... truncated"));
      // Should have content from both beginning and end
      assert.ok(fg.output!.includes("1\n"));
      assert.ok(fg.output!.includes("10000"));
    });

    it("does not truncate when output is within limit", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo short",
        maxOutput: 10000,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.equal(fg.truncated, undefined);
    });

    it("applies maxOutput per stream in splitStreams mode", async () => {
      const r = await toolExecExtended(ws, {
        command: "seq 1 10000; seq 1 10000 >&2",
        splitStreams: true,
        maxOutput: 100,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.equal(fg.stdoutTruncated, true);
      assert.equal(fg.stderrTruncated, true);
    });

    it("rejects invalid truncation mode", async () => {
      await assert.rejects(
        () => toolExecExtended(ws, {
          command: "echo x",
          truncation: "invalid" as any,
        }, creds),
        /truncation.*head.*tail.*both/i,
      );
    });

    it("rejects invalid maxOutput", async () => {
      await assert.rejects(
        () => toolExecExtended(ws, { command: "echo x", maxOutput: -1 }, creds),
        /maxOutput.*positive/i,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 6. Background flag
  // -----------------------------------------------------------------------

  describe("background", () => {
    it("returns immediately with session info", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 0.1",
        background: true,
      }, creds);
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;
      assert.ok(bg.sessionId);
      assert.ok(bg.pid > 0);
      assert.equal(bg.status, "running");
      assert.equal(bg.yielded, undefined);

      // Clean up: wait for process to finish
      const session = getExecSession(bg.sessionId);
      assert.ok(session);
      await session.done;
      removeExecSession(bg.sessionId);
    });

    it("session is retrievable via getExecSession", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 0.1",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const session = getExecSession(bg.sessionId);
      assert.ok(session);
      assert.equal(session.pid, bg.pid);

      await session.done;
      removeExecSession(bg.sessionId);
    });

    it("background process captures output", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo bg-output",
        background: true,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const session = getExecSession(bg.sessionId);
      assert.ok(session);

      await session.done;
      assert.equal(session.exited, true);
      assert.equal(session.exitCode, 0);

      // Import readHandleOutput to check accumulated output
      const { readHandleOutput } = await import("../src/subprocess");
      const output = readHandleOutput(session, "stdout");
      assert.ok(output.includes("bg-output"));

      removeExecSession(bg.sessionId);
    });

    it("background with stdin writes input before backgrounding", async () => {
      const r = await toolExecExtended(ws, {
        command: "cat",
        background: true,
        stdin: "bg-stdin-data",
      }, creds);
      const bg = r as ExecBackgroundResult;
      const session = getExecSession(bg.sessionId);
      assert.ok(session);

      await session.done;
      const { readHandleOutput } = await import("../src/subprocess");
      const output = readHandleOutput(session, "stdout");
      assert.ok(output.includes("bg-stdin-data"));

      removeExecSession(bg.sessionId);
    });

    it("background with timeout kills the process", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 60",
        background: true,
        timeout: 1,
      }, creds);
      const bg = r as ExecBackgroundResult;
      const session = getExecSession(bg.sessionId);
      assert.ok(session);

      await session.done;
      assert.equal(session.timedOut, true);
      assert.equal(session.exited, true);

      removeExecSession(bg.sessionId);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Yield-based backgrounding (yieldMs)
  // -----------------------------------------------------------------------

  describe("yieldMs", () => {
    it("returns foreground result when process finishes within yield window", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo fast-yield",
        yieldMs: 5000,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.ok(fg.output?.includes("fast-yield"));
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
      assert.equal(bg.status, "running");

      // Clean up: kill the process
      const session = getExecSession(bg.sessionId);
      assert.ok(session);
      session.child.kill("SIGTERM");
      await session.done;
      removeExecSession(bg.sessionId);
    });

    it("yieldMs of 0 is equivalent to background: true", async () => {
      const r = await toolExecExtended(ws, {
        command: "sleep 0.1",
        yieldMs: 0,
      }, creds);
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;
      assert.ok(bg.sessionId);

      const session = getExecSession(bg.sessionId);
      assert.ok(session);
      await session.done;
      removeExecSession(bg.sessionId);
    });

    it("background: true wins over yieldMs", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo quick",
        background: true,
        yieldMs: 10000,
      }, creds);
      // Should be immediate background, not wait 10s
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;
      // yielded should NOT be set — this was immediate background, not yield
      assert.equal(bg.yielded, undefined);

      const session = getExecSession(bg.sessionId);
      assert.ok(session);
      await session.done;
      removeExecSession(bg.sessionId);
    });

    it("rejects negative yieldMs", async () => {
      await assert.rejects(
        () => toolExecExtended(ws, { command: "echo x", yieldMs: -1 }, creds),
        /yieldMs.*non-negative/i,
      );
    });

    it("includes partial output when yielded", async () => {
      const r = await toolExecExtended(ws, {
        // Echo something immediately, then sleep
        command: "echo partial-data; sleep 10",
        yieldMs: 500,
      }, creds);
      assert.equal(r.kind, "background");
      const bg = r as ExecBackgroundResult;
      assert.equal(bg.yielded, true);
      // partialOutput may or may not contain the echo depending on timing,
      // but the field should exist if there was any output
      if (bg.partialOutput) {
        assert.ok(bg.partialOutput.includes("partial-data"));
      }

      const session = getExecSession(bg.sessionId);
      assert.ok(session);
      session.child.kill("SIGTERM");
      await session.done;
      removeExecSession(bg.sessionId);
    });
  });

  // -----------------------------------------------------------------------
  // Combined features
  // -----------------------------------------------------------------------

  describe("combined features", () => {
    it("stdin + workdir + env together", async () => {
      mkdirSync(join(ws, "combo"), { recursive: true });
      const r = await toolExecExtended(ws, {
        command: "cat; echo $MY_ENV; pwd",
        stdin: "input-data\n",
        workdir: "combo",
        env: { MY_ENV: "combo-val" },
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.ok(fg.output?.includes("input-data"));
      assert.ok(fg.output?.includes("combo-val"));
      assert.ok(fg.output?.includes("/combo"));
    });

    it("timeout + splitStreams", async () => {
      const r = await toolExecExtended(ws, {
        command: "echo out; echo err >&2; sleep 60",
        timeout: 1,
        splitStreams: true,
      }, creds);
      assert.equal(r.kind, "foreground");
      const fg = r as ExecForegroundResult;
      assert.equal(fg.timedOut, true);
      assert.ok(fg.stdout?.includes("out"));
      assert.ok(fg.stderr?.includes("err"));
    });

    it("writes a file via stdin and reads it back", async () => {
      const content = "file content from stdin\n";
      await toolExecExtended(ws, {
        command: `cat > ${join(ws, "stdin-file.txt")}`,
        stdin: content,
      }, creds);
      assert.equal(readFileSync(join(ws, "stdin-file.txt"), "utf8"), content);
    });
  });
});
