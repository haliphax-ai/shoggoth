// Regression tests: when lines/lineNumbers produce few but enormous lines,
// the final joined output must still pass through truncateToolOutput so the
// result cannot exceed the 50k byte cap. Also covers the plain path.

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { registerFsReadWrite as registerFs } from "../../src/sessions/builtin-handlers/fs-tools";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";

function makeTmpWorkspace(): string {
  const dir = join(tmpdir(), `shog-lines-bytecap-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stubCtx(workspacePath: string): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    db: {} as any,
    config: {} as any,
    env: {},
    workspacePath,
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

const TRUNCATION_NOTICE = "truncated — output exceeded 50,000 characters";

async function read(
  reg: BuiltinToolRegistry,
  ctx: BuiltinToolContext,
  args: Record<string, unknown>,
) {
  const result = await reg.execute("read", args, ctx);
  return JSON.parse(result.resultJson);
}

describe("fs-handlers: byte cap on lines/lineNumbers output", () => {
  let ws: string;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("caps a single enormous line with lines: true (plain path)", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx(ws);
    writeFileSync(join(ws, "minified.txt"), "x".repeat(60_000));

    const parsed = await read(reg, ctx, { path: "minified.txt", lines: true });

    assert.strictEqual(typeof parsed.content, "string", "byte cap should replace the array form");
    assert.ok(parsed.content.includes(TRUNCATION_NOTICE));
    assert.ok(parsed.content.length <= 50_000 + TRUNCATION_NOTICE.length);
  });

  it("caps a single enormous line with lineNumbers: true (plain path)", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx(ws);
    writeFileSync(join(ws, "minified.txt"), "y".repeat(60_000));

    const parsed = await read(reg, ctx, { path: "minified.txt", lineNumbers: true });

    assert.strictEqual(typeof parsed.content, "string");
    assert.ok(parsed.content.includes(TRUNCATION_NOTICE));
  });

  it("caps output on the extended read path (lines + fromLine)", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx(ws);
    writeFileSync(join(ws, "minified.txt"), "z".repeat(60_000));

    const parsed = await read(reg, ctx, { path: "minified.txt", lines: true, fromLine: 1 });

    assert.strictEqual(typeof parsed.content, "string");
    assert.ok(parsed.content.includes(TRUNCATION_NOTICE));
  });

  it("caps many long lines even after the 1000-line cap applied", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx(ws);
    const lines = Array.from({ length: 1500 }, (_, i) => `${i}`.padEnd(100, "a"));
    writeFileSync(join(ws, "wide.txt"), lines.join("\n"));

    const parsed = await read(reg, ctx, { path: "wide.txt", lines: true });

    assert.strictEqual(typeof parsed.content, "string", "byte cap beats the line cap");
    assert.ok(parsed.content.includes(TRUNCATION_NOTICE));
  });

  it("keeps the array form when output fits both caps", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx(ws);
    writeFileSync(join(ws, "small.txt"), "a\nb\nc\n");

    const parsed = await read(reg, ctx, { path: "small.txt", lines: true });

    assert.ok(Array.isArray(parsed.content));
    assert.deepStrictEqual(parsed.content, ["a", "b", "c", ""]);
  });

  it("keeps the line-count notice path intact for >1000 short lines", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx(ws);
    const lines = Array.from({ length: 1500 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(join(ws, "tall.txt"), lines.join("\n"));

    const parsed = await read(reg, ctx, { path: "tall.txt", lines: true });

    assert.ok(Array.isArray(parsed.content));
    assert.strictEqual(parsed.content.length, 1001);
    assert.ok(parsed.content[1000].includes("truncated"));
  });

  it("keeps the plain path byte-for-byte when under the cap", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx(ws);
    writeFileSync(join(ws, "plain.txt"), "hello world");

    const parsed = await read(reg, ctx, { path: "plain.txt" });

    assert.strictEqual(parsed.content, "hello world");
  });
});
