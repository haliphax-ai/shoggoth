// Integration tests: fs mutation tool actions end-to-end through the builtin
// registry with the persistent per-session helper (spawned via a real
// ProcessManager). Verifies result shapes and preserved error behavior.

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { ProcessManager } from "@shoggoth/procman";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { registerFsTools as registerFs } from "../../src/sessions/builtin-handlers/fs-tools";
import { disposeFsHelper, _resetFsHelpersForTests } from "../../src/sessions/fs-helper-process";

function stubCtx(workspacePath: string, procman: ProcessManager): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:77:helper",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    env: {},
    workspacePath,
    workspaceRealPath: workspacePath,
    creds: { uid: process.getuid!(), gid: process.getgid!() },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => procman,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

describe("fs mutation tools via the persistent helper", () => {
  let workspace: string;
  let procman: ProcessManager;
  let ctx: BuiltinToolContext;
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    workspace = mkdtempSync(join(osTmpdir(), "fs-helper-tools-"));
    procman = new ProcessManager();
    ctx = stubCtx(workspace, procman);
    registry = new BuiltinToolRegistry();
    registerFs(registry);
  });

  afterEach(async () => {
    await disposeFsHelper(ctx.sessionId);
    _resetFsHelpersForTests();
    await procman.stopAll();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("move relocates a file and reports workspace-relative paths", async () => {
    writeFileSync(join(workspace, "mv.txt"), "data");
    const result = await registry.execute(
      "fs",
      { action: "move", path: "mv.txt", dest: "sub/mv.txt" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.action, "move");
    assert.strictEqual(parsed.from, "mv.txt");
    assert.strictEqual(parsed.to, "sub/mv.txt");
    assert.strictEqual(readFileSync(join(workspace, "sub", "mv.txt"), "utf8"), "data");
    assert.ok(!existsSync(join(workspace, "mv.txt")));
  });

  it("copy duplicates files and directories recursively", async () => {
    writeFileSync(join(workspace, "src.txt"), "hello");
    mkdirSync(join(workspace, "dir"));
    writeFileSync(join(workspace, "dir", "inner.txt"), "inner");
    const result = await registry.execute(
      "fs",
      { action: "copy", path: "dir", dest: "dir-copy" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.action, "copy");
    assert.strictEqual(readFileSync(join(workspace, "dir-copy", "inner.txt"), "utf8"), "inner");
    assert.ok(existsSync(join(workspace, "dir", "inner.txt")), "original kept");
  });

  it("delete returns the removed count and honours recursive", async () => {
    mkdirSync(join(workspace, "tree", "sub"), { recursive: true });
    writeFileSync(join(workspace, "tree", "a.txt"), "1");
    writeFileSync(join(workspace, "tree", "sub", "b.txt"), "2");

    await assert.rejects(
      () => registry.execute("fs", { action: "delete", path: "tree" }, ctx),
      /recursive/,
    );
    assert.ok(existsSync(join(workspace, "tree", "a.txt")));

    const result = await registry.execute(
      "fs",
      { action: "delete", path: "tree", recursive: true },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.action, "delete");
    assert.strictEqual(parsed.count, 4);
    assert.ok(!existsSync(join(workspace, "tree")));
  });

  it("stat reports type, mode, uid and gid as the agent identity", async () => {
    writeFileSync(join(workspace, "s.txt"), "12345");
    const result = await registry.execute("fs", { action: "stat", path: "s.txt" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.action, "stat");
    assert.strictEqual(parsed.type, "file");
    assert.strictEqual(parsed.size, 5);
    assert.strictEqual(typeof parsed.mtime, "string");
    assert.strictEqual(typeof parsed.mode, "string");
    assert.strictEqual(parsed.uid, process.getuid!());
    assert.strictEqual(parsed.gid, process.getgid!());
  });

  it("chmod applies the octal mode", async () => {
    writeFileSync(join(workspace, "c.txt"), "x");
    const result = await registry.execute(
      "fs",
      { action: "chmod", path: "c.txt", mode: "600" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.mode, "600");
    assert.strictEqual(lstatSync(join(workspace, "c.txt")).mode & 0o777, 0o600);
  });

  it("mkdir creates nested directories and is idempotent", async () => {
    const first = await registry.execute(
      "fs",
      { action: "mkdir", path: "a/b/c", recursive: true },
      ctx,
    );
    const firstJson = JSON.parse(first.resultJson);
    assert.strictEqual(firstJson.ok, true);
    assert.ok(statSync(join(workspace, "a/b/c")).isDirectory());

    const again = await registry.execute(
      "fs",
      { action: "mkdir", path: "a/b/c", recursive: true },
      ctx,
    );
    assert.strictEqual(JSON.parse(again.resultJson).ok, true);
  });

  it("rejects invalid chmod modes before reaching the helper", async () => {
    const target = join(workspace, "v.txt");
    writeFileSync(target, "x");
    // Pin the mode so the assertion is independent of the environment umask.
    chmodSync(target, 0o644);
    await assert.rejects(() =>
      registry.execute("fs", { action: "chmod", path: "v.txt", mode: "999" }, ctx),
    );
    assert.strictEqual(lstatSync(target).mode & 0o777, 0o644);
  });

  it("requires dest for move and copy", async () => {
    writeFileSync(join(workspace, "n.txt"), "x");
    await assert.rejects(() => registry.execute("fs", { action: "move", path: "n.txt" }, ctx));
    await assert.rejects(() => registry.execute("fs", { action: "copy", path: "n.txt" }, ctx));
  });

  it("rejects paths escaping the workspace", async () => {
    await assert.rejects(() =>
      registry.execute("fs", { action: "mkdir", path: "../../escape" }, ctx),
    );
    await assert.rejects(() =>
      registry.execute("fs", { action: "delete", path: "../../escape" }, ctx),
    );
  });

  it("throws for unknown actions and missing path", async () => {
    await assert.rejects(() => registry.execute("fs", { action: "explode", path: "x" }, ctx));
    await assert.rejects(() => registry.execute("fs", { action: "mkdir" }, ctx));
  });

  it("spawned helper runs as the agent UID/GID (kernel DAC applies)", async () => {
    const result = await registry.execute("fs", { action: "mkdir", path: "owned" }, ctx);
    assert.strictEqual(JSON.parse(result.resultJson).ok, true);
    const st = statSync(join(workspace, "owned"));
    assert.strictEqual(st.uid, process.getuid!());
    assert.strictEqual(st.gid, process.getgid!());

    // chmod to read-only and verify the helper (agent uid) can still remove it
    // via its own identity — the daemon never touches the tree directly.
    chmodSync(join(workspace, "owned"), 0o555);
    const del = await registry.execute(
      "fs",
      { action: "delete", path: "owned", recursive: true },
      ctx,
    );
    assert.strictEqual(JSON.parse(del.resultJson).ok, true);
    assert.ok(!existsSync(join(workspace, "owned")));
  });

  it("one helper process serves repeated ops without respawn", async () => {
    await registry.execute("fs", { action: "mkdir", path: "d1" }, ctx);
    const afterFirst = procman.list().length;
    await registry.execute("fs", { action: "mkdir", path: "d2" }, ctx);
    await registry.execute("fs", { action: "mkdir", path: "d3" }, ctx);
    assert.strictEqual(procman.list().length, afterFirst, "no extra processes spawned");
  });
});
