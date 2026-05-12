import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

describe("builtin-write append mode", () => {
  let workspace: string;
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "write-handler-test-"));
    registry = new BuiltinToolRegistry();
    registerReadWrite(registry);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("appends content to an existing file when append is true", async () => {
    writeFileSync(join(workspace, "log.txt"), "line1\n");
    const ctx = stubCtx(workspace);

    const result = await registry.execute(
      "write",
      { path: "log.txt", content: "line2\n", append: true },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(readFileSync(join(workspace, "log.txt"), "utf8"), "line1\nline2\n");
  });

  it("creates a new file when append is true and file does not exist", async () => {
    const ctx = stubCtx(workspace);

    const result = await registry.execute(
      "write",
      { path: "new.log", content: "first\n", append: true },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(readFileSync(join(workspace, "new.log"), "utf8"), "first\n");
  });

  it("overwrites file when append is false (default behavior)", async () => {
    writeFileSync(join(workspace, "file.txt"), "old content\n");
    const ctx = stubCtx(workspace);

    const result = await registry.execute(
      "write",
      { path: "file.txt", content: "new content\n" },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(readFileSync(join(workspace, "file.txt"), "utf8"), "new content\n");
  });

  it("overwrites file when append is explicitly false", async () => {
    writeFileSync(join(workspace, "file.txt"), "old content\n");
    const ctx = stubCtx(workspace);

    const result = await registry.execute(
      "write",
      { path: "file.txt", content: "replaced\n", append: false },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(readFileSync(join(workspace, "file.txt"), "utf8"), "replaced\n");
  });
});
