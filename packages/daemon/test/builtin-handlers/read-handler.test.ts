import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerReadWrite } from "../../src/sessions/builtin-handlers/fs-handlers";

function stubCtx(workspacePath: string, workingDirectory?: string): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    env: {},
    workspacePath,
    workingDirectory,
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

describe("builtin-read with workingDirectory", () => {
  let workspace: string;
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "read-handler-test-"));
    registry = new BuiltinToolRegistry();
    registerReadWrite(registry);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("resolves relative paths against workingDirectory (simple read)", async () => {
    // Create a subdirectory with a file
    mkdirSync(join(workspace, "subdir"), { recursive: true });
    writeFileSync(join(workspace, "subdir", "test.txt"), "hello from subdir");

    // Set workingDirectory to the subdir
    const ctx = stubCtx(workspace, join(workspace, "subdir"));

    // Read using relative path "test.txt" - should resolve against workingDirectory
    const result = await registry.execute("read", { path: "test.txt" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.content, "hello from subdir");
  });

  it("resolves relative paths against workingDirectory (extended read with fromLine)", async () => {
    // Create a subdirectory with a file
    mkdirSync(join(workspace, "mydir"), { recursive: true });
    writeFileSync(join(workspace, "mydir", "file.txt"), "line1\nline2\nline3");

    // Set workingDirectory to the subdirectory
    const ctx = stubCtx(workspace, join(workspace, "mydir"));

    // Read using relative path with line range - should resolve against workingDirectory
    const result = await registry.execute(
      "read",
      { path: "file.txt", fromLine: 1, toLine: 2 },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.content, "line1\nline2");
  });

  it("resolves relative paths against workingDirectory (extended read with stat)", async () => {
    // Create a subdirectory with a file
    mkdirSync(join(workspace, "datadir"), { recursive: true });
    writeFileSync(join(workspace, "datadir", "data.txt"), "some data");

    // Set workingDirectory to the subdirectory
    const ctx = stubCtx(workspace, join(workspace, "datadir"));

    // Read using relative path with stat - should resolve against workingDirectory
    const result = await registry.execute("read", { path: "data.txt", stat: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.stat.type, "file");
  });

  it("resolves paths array against workingDirectory (multi-path read)", async () => {
    // Create multiple subdirectories with files
    mkdirSync(join(workspace, "dir1"), { recursive: true });
    mkdirSync(join(workspace, "dir2"), { recursive: true });
    writeFileSync(join(workspace, "dir1", "a.txt"), "content a");
    writeFileSync(join(workspace, "dir2", "b.txt"), "content b");

    // Set workingDirectory to workspace, read multiple relative paths
    const ctx = stubCtx(workspace, workspace);

    // Read using paths array with relative paths
    const result = await registry.execute("read", { paths: ["dir1/a.txt", "dir2/b.txt"] }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.files["dir1/a.txt"], "content a");
    assert.strictEqual(parsed.files["dir2/b.txt"], "content b");
  });

  it("falls back to workspacePath when workingDirectory is not set", async () => {
    // Create a file at workspace root
    writeFileSync(join(workspace, "root.txt"), "at root");

    // No workingDirectory set - should fall back to workspacePath
    const ctx = stubCtx(workspace);

    const result = await registry.execute("read", { path: "root.txt" }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.content, "at root");
  });

  it("handles absolute paths correctly (ignores workingDirectory)", async () => {
    // Create files
    mkdirSync(join(workspace, "other"), { recursive: true });
    writeFileSync(join(workspace, "other", "absolute.txt"), "absolute path content");

    // Set workingDirectory but use absolute path
    const ctx = stubCtx(workspace, join(workspace, "subdir"));

    // Use absolute path - should ignore workingDirectory
    const absPath = join(workspace, "other", "absolute.txt");
    const result = await registry.execute("read", { path: absPath }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.content, "absolute path content");
  });
});
