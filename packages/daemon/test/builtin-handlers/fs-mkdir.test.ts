import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerFs } from "../../src/sessions/builtin-handlers/fs-handler";

function stubCtx(workspacePath: string): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    env: {},
    workspacePath,
    workspaceRealPath: realpathSync(workspacePath),
    creds: { uid: process.getuid!(), gid: process.getgid!() },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

describe("builtin-fs mkdir action", () => {
  let workspace: string;
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fs-mkdir-test-"));
    registry = new BuiltinToolRegistry();
    registerFs(registry);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("creates a single directory", async () => {
    const ctx = stubCtx(workspace);
    const result = await registry.execute("fs", { action: "mkdir", path: "newdir" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.action, "mkdir");
    assert.strictEqual(parsed.path, "newdir");
    assert.ok(existsSync(join(workspace, "newdir")));
    assert.ok(statSync(join(workspace, "newdir")).isDirectory());
  });

  it("creates nested directories with recursive: true", async () => {
    const ctx = stubCtx(workspace);
    const result = await registry.execute(
      "fs",
      { action: "mkdir", path: "a/b/c", recursive: true },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.action, "mkdir");
    assert.strictEqual(parsed.path, "a/b/c");
    assert.ok(existsSync(join(workspace, "a/b/c")));
    assert.ok(statSync(join(workspace, "a/b/c")).isDirectory());
  });

  it("fails for nested path without recursive: true", async () => {
    const ctx = stubCtx(workspace);
    await assert.rejects(() => registry.execute("fs", { action: "mkdir", path: "x/y/z" }, ctx));
  });

  it("succeeds silently when directory already exists", async () => {
    const ctx = stubCtx(workspace);
    // Create it first
    await registry.execute("fs", { action: "mkdir", path: "existing" }, ctx);
    // Create again — should not throw
    const result = await registry.execute("fs", { action: "mkdir", path: "existing" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, true);
  });

  it("rejects paths that escape the workspace", async () => {
    const ctx = stubCtx(workspace);
    await assert.rejects(() =>
      registry.execute("fs", { action: "mkdir", path: "../../escape" }, ctx),
    );
  });

  it("runs as the agent UID/GID", async () => {
    const ctx = stubCtx(workspace);
    await registry.execute("fs", { action: "mkdir", path: "owned" }, ctx);
    const st = statSync(join(workspace, "owned"));
    assert.strictEqual(st.uid, process.getuid!());
    assert.strictEqual(st.gid, process.getgid!());
  });
});
