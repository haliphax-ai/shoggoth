// Tests for builtin-read lines, lineNumbers, fromLine, toLine, offset, limit, paths, and stat params
// These were missing and caused the regex bug to slip through

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { register as registerFs } from "../../src/sessions/builtin-handlers/fs-handlers";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";

function makeTmpWorkspace(): string {
  const dir = join(tmpdir(), `shog-lines-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

describe("fs-handlers: lines flag", () => {
  let ws: string;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("splits content by newlines when lines: true", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.txt"), "line1\nline2\nline3\n");

    const result = await reg.execute("read", { path: "test.txt", lines: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Array.isArray(parsed.content), "content should be an array");
    // Trailing newline produces an empty trailing element
    assert.strictEqual(parsed.content.length, 4, "should have 4 elements (trailing newline)");
    assert.strictEqual(parsed.content[0], "line1");
    assert.strictEqual(parsed.content[1], "line2");
    assert.strictEqual(parsed.content[2], "line3");
    assert.strictEqual(parsed.content[3], "");
  });

  it("handles CRLF line endings", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "crlf.txt"), "line1\r\nline2\r\nline3\r\n");

    const result = await reg.execute("read", { path: "crlf.txt", lines: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Array.isArray(parsed.content));
    assert.strictEqual(parsed.content.length, 4);
    assert.strictEqual(parsed.content[0], "line1");
    assert.strictEqual(parsed.content[1], "line2");
    assert.strictEqual(parsed.content[2], "line3");
    assert.strictEqual(parsed.content[3], "");
  });

  it("handles CR line endings", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "cr.txt"), "line1\rline2\rline3\r");

    const result = await reg.execute("read", { path: "cr.txt", lines: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Array.isArray(parsed.content));
    assert.strictEqual(parsed.content.length, 4);
  });

  it("truncates files over 1000 lines when lines: true", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    const lines = [];
    for (let i = 1; i <= 1500; i++) {
      lines.push(`Line ${i}`);
    }
    writeFileSync(join(ws, "big.txt"), lines.join("\n"));

    const result = await reg.execute("read", { path: "big.txt", lines: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Array.isArray(parsed.content));
    // 1000 lines from truncation + 1 truncation notice
    assert.strictEqual(parsed.content.length, 1001);
    assert.strictEqual(parsed.content[0], "Line 1");
    assert.ok(parsed.content[1000].includes("truncated"));
  });

  it("handles empty file with lines: true", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "empty.txt"), "");

    const result = await reg.execute("read", { path: "empty.txt", lines: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Array.isArray(parsed.content));
    // Empty string split gives [""]
    assert.strictEqual(parsed.content.length, 1);
    assert.strictEqual(parsed.content[0], "");
  });

  it("preserves lines with only newlines", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "newlines.txt"), "\n\n\n");

    const result = await reg.execute("read", { path: "newlines.txt", lines: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Array.isArray(parsed.content));
    const nonEmpty = parsed.content.filter((s: string) => s.length > 0);
    assert.strictEqual(parsed.content.length, 4);
    assert.strictEqual(nonEmpty.length, 0);
  });
});

describe("fs-handlers: lineNumbers flag", () => {
  let ws: string;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("prefixes lines with 1-indexed numbers and returns array", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.txt"), "first\nsecond\nthird\n");

    const result = await reg.execute("read", { path: "test.txt", lineNumbers: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    // Handler returns array when lineNumbers is true (no extended path needed)
    assert.ok(Array.isArray(parsed.content));
    assert.strictEqual(parsed.content[0], "1: first");
    assert.strictEqual(parsed.content[1], "2: second");
    assert.strictEqual(parsed.content[2], "3: third");
  });

  it("handles empty file", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "empty.txt"), "");

    const result = await reg.execute("read", { path: "empty.txt", lineNumbers: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Array.isArray(parsed.content));
    assert.strictEqual(parsed.content.length, 1);
    assert.strictEqual(parsed.content[0], "1: ");
  });

  it("handles file with only newlines", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "newlines.txt"), "\n\n\n");

    const result = await reg.execute("read", { path: "newlines.txt", lineNumbers: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Array.isArray(parsed.content));
    assert.strictEqual(parsed.content.length, 4);
  });
});

describe("fs-handlers: fromLine/toLine range", () => {
  let ws: string;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("reads lines 2-4 from a 5-line file", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.txt"), "line1\nline2\nline3\nline4\nline5\n");

    const result = await reg.execute("read", { path: "test.txt", fromLine: 2, toLine: 4 }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(typeof parsed.content === "string");
    assert.ok(parsed.content.includes("line2"));
    assert.ok(parsed.content.includes("line3"));
    assert.ok(parsed.content.includes("line4"));
    assert.ok(!parsed.content.includes("line1"));
    assert.ok(!parsed.content.includes("line5"));
  });

  it("handles fromLine=1, toLine=1", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.txt"), "first\nsecond\nthird\n");

    const result = await reg.execute("read", { path: "test.txt", fromLine: 1, toLine: 1 }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(parsed.content.includes("first"));
    assert.ok(!parsed.content.includes("second"));
  });
});

describe("fs-handlers: offset/limit range", () => {
  let ws: string;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("reads 3 lines starting from offset 2", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.txt"), "line1\nline2\nline3\nline4\nline5\n");

    const result = await reg.execute("read", { path: "test.txt", offset: 2, limit: 3 }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(typeof parsed.content === "string");
    assert.ok(parsed.content.includes("line2"));
    assert.ok(parsed.content.includes("line3"));
    assert.ok(parsed.content.includes("line4"));
    assert.ok(!parsed.content.includes("line1"));
    assert.ok(!parsed.content.includes("line5"));
  });

  it("handles offset=1, limit=1", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.txt"), "first\nsecond\nthird\n");

    const result = await reg.execute("read", { path: "test.txt", offset: 1, limit: 1 }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(parsed.content.includes("first"));
    assert.ok(!parsed.content.includes("second"));
  });
});

describe("fs-handlers: stat mode", () => {
  let ws: string;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("returns metadata for single file", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.txt"), "hello world");

    const result = await reg.execute("read", { path: "test.txt", stat: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(parsed.stat);
    assert.strictEqual(typeof parsed.stat.size, "number");
    assert.strictEqual(parsed.stat.size, 11);
    assert.strictEqual(parsed.stat.type, "file");
    assert.ok(parsed.stat.mtime);
    assert.ok(parsed.stat.permissions);
  });

  it("includes line count for small files", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.txt"), "line1\nline2\nline3\n");

    const result = await reg.execute("read", { path: "test.txt", stat: true }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(parsed.stat);
    assert.ok(parsed.stat.lines !== undefined);
    assert.strictEqual(parsed.stat.lines, 3);
  });
});

describe("fs-handlers: paths/globs", () => {
  let ws: string;

  beforeEach(() => {
    ws = makeTmpWorkspace();
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("reads multiple files from paths array", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "file1.txt"), "content1");
    writeFileSync(join(ws, "file2.txt"), "content2");
    writeFileSync(join(ws, "file3.txt"), "content3");

    const result = await reg.execute("read", { paths: ["file1.txt", "file2.txt"] }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(parsed.files);
    assert.strictEqual(Object.keys(parsed.files).length, 2);
    assert.strictEqual(parsed.files["file1.txt"], "content1");
    assert.strictEqual(parsed.files["file2.txt"], "content2");
  });

  it("honors maxFiles limit with notice", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "a.txt"), "a");
    writeFileSync(join(ws, "b.txt"), "b");
    writeFileSync(join(ws, "c.txt"), "c");

    const result = await reg.execute("read", { paths: ["a.txt", "b.txt", "c.txt"], maxFiles: 1 }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(Object.keys(parsed.files).length <= 1);
  });

  it("handles glob patterns", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "test.js"), "code1");
    writeFileSync(join(ws, "test2.js"), "code2");
    writeFileSync(join(ws, "readme.md"), "docs");

    const result = await reg.execute("read", { paths: ["*.js"] }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.strictEqual(Object.keys(parsed.files).length, 2);
    assert.ok(parsed.files["test.js"] === "code1");
    assert.ok(parsed.files["test2.js"] === "code2");
    assert.ok(!parsed.files["readme.md"]);
  });

  it("handles non-existent file path gracefully", async () => {
    const reg = new BuiltinToolRegistry();
    registerFs(reg);
    const ctx = stubCtx({ workspacePath: ws, creds: { uid: process.getuid!(), gid: process.getgid!() } });
    writeFileSync(join(ws, "real.txt"), "exists");

    const result = await reg.execute("read", { paths: ["real.txt", "nope.txt"] }, ctx);
    const parsed = JSON.parse(result.resultJson);

    assert.ok(parsed.files);
    assert.strictEqual(parsed.files["real.txt"], "exists");
    assert.ok(typeof parsed.files["nope.txt"] === "string");
  });
});
