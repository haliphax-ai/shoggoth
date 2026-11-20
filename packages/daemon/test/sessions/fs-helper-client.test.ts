// Tests for FsHelperClient: lazy spawn via procman, framed round-trips,
// pending-request failure on exit, and dispose semantics. Uses a stub
// process manager with a real `node fs-helper-entry.mjs` child.

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  FsHelperClient,
  getFsHelperClient,
  disposeFsHelper,
  _resetFsHelpersForTests,
  type FsHelperProcessManager,
} from "../../src/sessions/fs-helper-process";

const entryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "sessions",
  "fs-helper-entry.mjs",
);

/**
 * Minimal procman stand-in: spawns a real helper child and exposes it as a
 * ManagedProcess-shaped object (state, writeStdin, stdout/exit events).
 */
class StubProcman implements FsHelperProcessManager {
  readonly started: unknown[] = [];
  readonly stopped: string[] = [];
  failStart = false;
  private child: ChildProcess | undefined;
  private managed: StubManaged | undefined;

  async start(spec: {
    command: string;
    args?: string[];
    uid?: number;
    gid?: number;
  }): Promise<StubManaged> {
    this.started.push(spec);
    if (this.failStart) {
      // Mirror procman: start() records failure in state instead of throwing.
      const failed = new StubManaged(null);
      failed.state = "failed";
      return failed;
    }
    const child = spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      uid: spec.uid,
      gid: spec.gid,
    });
    child.stderr?.resume();
    this.child = child;
    const managed = new StubManaged(child);
    this.managed = managed;
    // Same contract as ManagedProcess.start(): await the child's actual
    // 'spawn' event, flip to "running", then resolve — resolving earlier
    // would race the client's post-start state check.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    managed.markRunning();
    return managed;
  }

  async stop(id: string): Promise<void> {
    this.stopped.push(id);
    this.child?.kill();
    this.child = undefined;
  }

  current(): StubManaged | undefined {
    return this.managed;
  }
}

/** ManagedProcess-shaped wrapper around a real child (subset the client uses). */
class StubManaged extends EventEmitter {
  state: "starting" | "running" | "dead" | "failed" = "starting";
  private readonly child: ChildProcess | null;

  constructor(child: ChildProcess | null) {
    super();
    this.child = child;
    if (child) {
      child.stdout?.on("data", (chunk: Buffer) => this.emit("stdout", chunk));
      child.once("exit", () => {
        this.state = "dead";
        this.emit("exit");
      });
    }
  }

  markRunning(): void {
    this.state = "running";
  }

  writeStdin(data: string): void {
    if (!this.child?.stdin?.writable) {
      throw new Error("stdin not writable");
    }
    this.child.stdin.write(data);
  }
}

describe("FsHelperClient", () => {
  let workspace: string;
  let procman: StubProcman;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fs-helper-client-"));
    writeFileSync(join(workspace, "seed.txt"), "seed");
    procman = new StubProcman();
    _resetFsHelpersForTests();
  });

  afterEach(async () => {
    _resetFsHelpersForTests();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function makeClient(sessionId = "agent:test:discord:channel:1:abc"): FsHelperClient {
    return new FsHelperClient({
      sessionId,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      workspacePath: workspace,
      processManager: procman,
      entryPath,
    });
  }

  it("spawns lazily on first request and reuses the process across requests", async () => {
    const client = makeClient();
    const r1 = await client.request("mkdir", { src: join(workspace, "d1") });
    assert.strictEqual(r1.ok, true);
    const afterFirst = procman.started.length;

    const r2 = await client.request("stat", { src: join(workspace, "seed.txt") });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual((r2.info as Record<string, unknown>).type, "file");
    assert.strictEqual(procman.started.length, afterFirst, "no respawn for warm helper");
  });

  it("resolves concurrent requests issued while spawning", async () => {
    const client = makeClient();
    // Two requests back-to-back: the second must not spawn a second helper.
    const [r1, r2] = await Promise.all([
      client.request("mkdir", { src: join(workspace, "a") }),
      client.request("mkdir", { src: join(workspace, "b") }),
    ]);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(procman.started.length, 1);
  });

  it("rejects pending requests when the helper exits", async () => {
    const client = makeClient();
    await client.request("mkdir", { src: join(workspace, "d") });
    const managed = procman.current()!;
    assert.ok(managed, "helper should be running");

    const pending = client.request("stat", { src: join(workspace, "seed.txt") });
    // Kill the child; the client must fail the pending request and respawn on
    // the next call.
    managed.state = "dead";
    managed.emit("exit");

    await assert.rejects(() => pending, /fs helper exited/);
  });

  it("respawns automatically after a helper crash", async () => {
    const client = makeClient();
    await client.request("mkdir", { src: join(workspace, "d") });
    const first = procman.current()!;
    first.state = "dead";
    first.emit("exit");

    const r = await client.request("mkdir", { src: join(workspace, "d2") });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(procman.started.length, 2, "helper respawned after crash");
    assert.notStrictEqual(procman.current(), first);
  });

  it("resolves helper-reported failures as {ok:false,error} payloads", async () => {
    const client = makeClient();
    const res = await client.request("stat", { src: join(workspace, "missing.txt") });
    assert.strictEqual(res.ok, false);
    assert.match(String(res.error), /ENOENT|no such file/i);
    // The helper stays healthy and answers the next request.
    const next = await client.request("stat", { src: join(workspace, "seed.txt") });
    assert.strictEqual(next.ok, true);
  });

  it("surfaces a start failure instead of wiring a dead process", async () => {
    procman.failStart = true;
    const client = makeClient();
    await assert.rejects(
      () => client.request("mkdir", { src: join(workspace, "d") }),
      /failed to start/,
    );
  });

  it("dispose stops the process and rejects new requests", async () => {
    const client = makeClient();
    await client.request("mkdir", { src: join(workspace, "d") });
    const sessionId = "agent:test:discord:channel:1:abc";
    await client.dispose();
    assert.deepStrictEqual(procman.stopped, [`fs-helper-${sessionId}`]);
    await assert.rejects(() => client.request("mkdir", { src: join(workspace, "d2") }), /disposed/);
  });

  it("per-session singleton returns the same client and dispose tears it down", async () => {
    const sessionId = "agent:test:discord:channel:2:def";
    const opts = {
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      workspacePath: workspace,
      processManager: procman,
      entryPath,
    };
    const a = getFsHelperClient(sessionId, opts);
    const b = getFsHelperClient(sessionId, opts);
    assert.strictEqual(a, b);

    await a.request("mkdir", { src: join(workspace, "s") });
    await disposeFsHelper(sessionId);
    assert.deepStrictEqual(procman.stopped, [`fs-helper-${sessionId}`]);

    // After dispose, a fresh client is created on next access.
    const c = getFsHelperClient(sessionId, opts);
    assert.notStrictEqual(c, a);
    const r = await c.request("mkdir", { src: join(workspace, "s2") });
    assert.strictEqual(r.ok, true);
  });

  it("disposeFsHelper is a no-op for sessions without a helper", async () => {
    await disposeFsHelper("agent:never-spawned:1");
  });
});
