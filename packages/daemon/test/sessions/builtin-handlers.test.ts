import { describe, it } from "vitest";
import assert from "node:assert";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerConfig } from "../../src/sessions/builtin-handlers/config-handlers";
import { register as registerProcman } from "../../src/sessions/builtin-handlers/procman-handlers";
import { register as registerMessage } from "../../src/sessions/builtin-handlers/message-handler";

function stubCtx(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    db: {} as any,
    config: {} as any,
    env: {},
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// config.show
// ---------------------------------------------------------------------------

describe("config.show handler", () => {
  it("returns error when integration invoker is unavailable", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    const result = await reg.execute("config-show", {}, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "config_show_unavailable",
    });
  });

  it("returns result from integration invoker", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    const ctx = stubCtx({
      getAgentIntegrationInvoker: () =>
        async (_sid: string, _op: string, _payload: unknown) => ({ some: "config" }),
    });
    const result = await reg.execute("config-show", {}, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), { some: "config" });
  });

  it("catches IntegrationOpError and returns structured error", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    // Dynamically import IntegrationOpError to construct a real instance
    const { IntegrationOpError } = await import("../../src/control/integration-ops");
    const ctx = stubCtx({
      getAgentIntegrationInvoker: () =>
        async () => { throw new IntegrationOpError("FORBIDDEN", "not allowed"); },
    });
    const result = await reg.execute("config-show", {}, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, "FORBIDDEN");
    assert.strictEqual(parsed.message, "not allowed");
  });
});

// ---------------------------------------------------------------------------
// config.request
// ---------------------------------------------------------------------------

describe("config.request handler", () => {
  it("returns error when integration invoker is unavailable", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    const result = await reg.execute("config-request", { fragment: "agents" }, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "config_request_unavailable",
    });
  });

  it("passes fragment to integration invoker", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    let capturedPayload: unknown;
    const ctx = stubCtx({
      getAgentIntegrationInvoker: () =>
        async (_sid: string, _op: string, payload: unknown) => {
          capturedPayload = payload;
          return { ok: true };
        },
    });
    const result = await reg.execute("config-request", { fragment: "agents" }, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), { ok: true });
    assert.deepStrictEqual(capturedPayload, { key: undefined, fragment: "agents", mode: undefined });
  });
});

// ---------------------------------------------------------------------------
// procman
// ---------------------------------------------------------------------------

describe("procman handler", () => {
  it("returns error when process manager is unavailable", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const result = await reg.execute("procman", { action: "list" }, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "process manager not available",
    });
  });

  it("lists processes", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = {
      list: () => [
        {
          spec: { id: "proc-1", label: "test", owner: "agent:test" },
          state: "running",
          pid: 1234,
          uptimeMs: 5000,
          restartCount: 0,
        },
      ],
    };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "list" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.processes.length, 1);
    assert.strictEqual(parsed.processes[0].id, "proc-1");
    assert.strictEqual(parsed.processes[0].state, "running");
    assert.strictEqual(parsed.processes[0].pid, 1234);
  });

  it("inspects a process by id", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = {
      get: (id: string) =>
        id === "proc-1"
          ? {
              spec: { id: "proc-1", label: "test", owner: "agent:test" },
              state: "running",
              pid: 1234,
              uptimeMs: 5000,
              restartCount: 0,
              lastExitCode: null,
              lastSignal: null,
              readOutput: (stream: string) => stream === "stdout" ? "hello" : "",
            }
          : undefined,
    };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "inspect", id: "proc-1" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.id, "proc-1");
    assert.strictEqual(parsed.recentStdout, "hello");
    assert.strictEqual(parsed.recentStderr, "");
  });

  it("returns error for inspect without id", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = { get: () => undefined };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "inspect" }, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "id required for inspect",
    });
  });

  it("returns error for unknown process id", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = { get: () => undefined };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "inspect", id: "nope" }, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: 'no process with id "nope"',
    });
  });

  it("returns error for unknown action", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = { list: () => [] };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "restart" }, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "unknown procman action: restart",
    });
  });
});

// ---------------------------------------------------------------------------
// message handler
// ---------------------------------------------------------------------------

describe("message handler", () => {
  it("returns error when message tool context is unavailable", async () => {
    const reg = new BuiltinToolRegistry();
    registerMessage(reg);
    const result = await reg.execute("message", { action: "send" }, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "message_tool_unavailable",
    });
  });

  it("delegates to message tool context execute", async () => {
    const reg = new BuiltinToolRegistry();
    registerMessage(reg);
    let capturedArgs: Record<string, unknown> | undefined;
    const ctx = stubCtx({
      messageToolCtx: {
        execute: async (_sid: string, args: Record<string, unknown>) => {
          capturedArgs = args;
          return { ok: true, messageId: "msg-1" };
        },
      },
    });
    const result = await reg.execute("message", { action: "send", target: "#general" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.messageId, "msg-1");
    assert.deepStrictEqual(capturedArgs, { action: "send", target: "#general" });
  });
});

// ---------------------------------------------------------------------------
// fs-handlers: image read support
// ---------------------------------------------------------------------------

import { register as registerFs } from "../../src/sessions/builtin-handlers/fs-handlers";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ImageBlockCodec, ImageBlock } from "@shoggoth/models";

function makeTmpWorkspace(): string {
  const dir = join(tmpdir(), `shog-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const fakeCodec: ImageBlockCodec = {
  supportsUrl: false,
  encode(block: ImageBlock) { return { type: "image", block }; },
  decode() { return null; },
};

describe("fs-handlers image read", () => {
  it("returns contentParts with image block for .png file", async () => {
    const ws = makeTmpWorkspace();
    try {
      const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeFileSync(join(ws, "test.png"), imgBytes);
      const reg = new BuiltinToolRegistry();
      registerFs(reg);
      const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() }, imageBlockCodec: fakeCodec });
      const result = await reg.execute("read", { path: "test.png" }, ctx);
      assert.ok(result.contentParts, "should have contentParts");
      assert.strictEqual(result.contentParts!.length, 2);
      const imgPart = result.contentParts![0] as ImageBlock;
      assert.strictEqual(imgPart.type, "image");
      assert.strictEqual(imgPart.mediaType, "image/png");
      assert.strictEqual(imgPart.base64, imgBytes.toString("base64"));
      const textPart = result.contentParts![1] as { type: "text"; text: string };
      assert.strictEqual(textPart.type, "text");
      assert.ok(textPart.text.includes("test.png"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("returns plain text for .txt file (unchanged)", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "hello.txt"), "hello world");
      const reg = new BuiltinToolRegistry();
      registerFs(reg);
      const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() }, imageBlockCodec: fakeCodec });
      const result = await reg.execute("read", { path: "hello.txt" }, ctx);
      assert.strictEqual(result.contentParts, undefined);
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(parsed.content, "hello world");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("returns error for image without codec", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "pic.jpg"), Buffer.from([0xff, 0xd8]));
      const reg = new BuiltinToolRegistry();
      registerFs(reg);
      const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
      const result = await reg.execute("read", { path: "pic.jpg" }, ctx);
      assert.strictEqual(result.contentParts, undefined);
      const parsed = JSON.parse(result.resultJson);
      assert.ok(parsed.error.includes("not supported"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("returns error for oversized image", async () => {
    const ws = makeTmpWorkspace();
    try {
      // Create a file just over 5 MB
      const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x42);
      writeFileSync(join(ws, "huge.png"), big);
      const reg = new BuiltinToolRegistry();
      registerFs(reg);
      const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() }, imageBlockCodec: fakeCodec });
      const result = await reg.execute("read", { path: "huge.png" }, ctx);
      assert.strictEqual(result.contentParts, undefined);
      const parsed = JSON.parse(result.resultJson);
      assert.ok(parsed.error.includes("too large"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// fs-handlers: large file read truncation
// ---------------------------------------------------------------------------

describe("fs-handlers read truncation", () => {
  it("truncates file content over 50k characters", async () => {
    const ws = makeTmpWorkspace();
    try {
      const bigContent = "A".repeat(10_000) + "M".repeat(50_000) + "Z".repeat(10_000);
      writeFileSync(join(ws, "big.txt"), bigContent);
      const reg = new BuiltinToolRegistry();
      registerFs(reg);
      const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
      const result = await reg.execute("read", { path: "big.txt" }, ctx);
      const parsed = JSON.parse(result.resultJson);
      assert.ok(parsed.content.length < bigContent.length, "content should be truncated");
      assert.ok(parsed.content.startsWith("A".repeat(10_000)), "should keep first 10k");
      assert.ok(parsed.content.endsWith("Z".repeat(10_000)), "should keep last 10k");
      assert.ok(parsed.content.includes("[... truncated"), "should include truncation notice");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("does not truncate file content under 50k characters", async () => {
    const ws = makeTmpWorkspace();
    try {
      const content = "x".repeat(49_000);
      writeFileSync(join(ws, "small.txt"), content);
      const reg = new BuiltinToolRegistry();
      registerFs(reg);
      const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
      const result = await reg.execute("read", { path: "small.txt" }, ctx);
      const parsed = JSON.parse(result.resultJson);
      assert.equal(parsed.content, content);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
