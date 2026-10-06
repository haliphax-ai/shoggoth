/**
 * Regression tests: every stdio spawn/child failure mode must fail the connect
 * promptly (no 60s hang) and must never surface as an unhandled 'error' event
 * — an unhandled ChildProcess 'error' is an uncaught exception that takes the
 * whole daemon down.
 */
import assert from "node:assert";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { ProcessManager } from "@shoggoth/procman";
import { connectMcpStdioSession, openMcpStdioClient } from "../src/mcp-jsonrpc-transport";

/** A command that exists nowhere on the filesystem (ENOENT). */
const MISSING_COMMAND = "/nonexistent/shoggoth-mcp-does-not-exist";

/** Anything that means "the connect failed fast" rather than hanging. */
const FAIL_PATTERN = /spawn failed|stream ended|EACCES|ENOENT|failed to start/;

async function expectPromptReject(
  p: Promise<unknown>,
  label: string,
  budgetMs = 10_000,
): Promise<void> {
  const started = Date.now();
  await assert.rejects(p, FAIL_PATTERN, `${label} must reject`);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < budgetMs, `${label} must fail promptly (took ${elapsed}ms)`);
}

describe("stdio connect spawn failures (direct spawn)", () => {
  it("rejects promptly for a nonexistent command (ENOENT)", async () => {
    await expectPromptReject(
      openMcpStdioClient({ command: MISSING_COMMAND }),
      "nonexistent command",
    );
  });

  it("rejects promptly for a non-executable file (EACCES)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shoggoth-spawn-"));
    const file = join(dir, "not-executable");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o644);
    await expectPromptReject(openMcpStdioClient({ command: file }), "non-executable file");
  });

  it("fails the connect when the process exits before initialize", async () => {
    await expectPromptReject(
      openMcpStdioClient({ command: process.execPath, args: ["-e", "process.exit(7)"] }),
      "immediate exit",
    );
  });

  it("fails the connect when the process dies by signal before initialize", async () => {
    await expectPromptReject(
      openMcpStdioClient({
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
      }),
      "signal death",
    );
  });

  it("close() does not stall when the server already died", async () => {
    const started = Date.now();
    const session = await connectMcpStdioSession({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    // Give the child time to die, then close: must not wait the 5s kill grace.
    await new Promise((r) => setTimeout(r, 300));
    await session.close();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4_000, `close after death must not wait the grace (took ${elapsed}ms)`);
  });
});

describe("stdio connect spawn failures (via procman)", () => {
  it("rejects promptly for a nonexistent command and cleans up", async () => {
    const pm = new ProcessManager();
    try {
      await expectPromptReject(
        openMcpStdioClient({ command: MISSING_COMMAND, processManager: pm }),
        "procman nonexistent command",
      );
      // The managed process must not be left registered/restarting forever.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(pm.listByOwner({ kind: "mcp-server" }).length, 0, "no leaked managed process");
    } finally {
      await pm.stopAll().catch(() => {});
    }
  });

  it("fails the connect when the server dies before initialize (via procman)", async () => {
    const pm = new ProcessManager();
    try {
      await expectPromptReject(
        openMcpStdioClient({
          command: process.execPath,
          args: ["-e", "process.exit(7)"],
          processManager: pm,
        }),
        "procman immediate exit",
      );
    } finally {
      await pm.stopAll().catch(() => {});
    }
  });
});
