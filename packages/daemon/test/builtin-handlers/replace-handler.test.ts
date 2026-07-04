import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { register } from "../../src/sessions/builtin-handlers/replace-handler";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import type Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("replace-handler", () => {
  let registry: BuiltinToolRegistry;
  let workspacePath: string;
  let testFilePath: string;
  let ctx: BuiltinToolContext;

  beforeEach(() => {
    registry = new BuiltinToolRegistry();
    register(registry);

    workspacePath = mkdtempSync(join(tmpdir(), "shoggoth-test-"));
    testFilePath = join(workspacePath, "test.txt");

    ctx = {
      sessionId: "test-session",
      db: {} as Database.Database,
      config: {} as any,
      env: {},
      workspacePath,
      creds: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
      orchestratorEnv: {},
      getAgentIntegrationInvoker: () => undefined,
      getProcessManager: () => undefined,
      messageToolCtx: undefined,
      memoryConfig: {} as any,
      runtimeOpenaiBaseUrl: undefined,
      isSubagentSession: false,
    };
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  async function runReplace(args: Record<string, unknown>) {
    return registry.execute("replace", args, ctx);
  }

  describe("multiline regex support", () => {
    it("should support \\n in patterns when multiline is true", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        pattern: "line1\\nline2",
        replacement: "replaced",
        multiline: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(1);
      expect(readFileSync(testFilePath, "utf8")).toBe("replaced\nline3");
    });

    it("should match line boundaries with multiline flag", async () => {
      writeFileSync(testFilePath, "start middle end\nstart middle end");

      const result = await runReplace({
        path: "test.txt",
        pattern: "^start.*end$",
        replacement: "matched",
        multiline: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(2);
      expect(readFileSync(testFilePath, "utf8")).toBe("matched\nmatched");
    });

    it("should not match line boundaries without multiline flag", async () => {
      writeFileSync(testFilePath, "start middle end\nstart middle end");

      const result = await runReplace({
        path: "test.txt",
        pattern: "^start.*end$",
        replacement: "matched",
        multiline: false,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(0);
    });

    it("should work with case-insensitive multiline", async () => {
      writeFileSync(testFilePath, "Line1\nLINE2\nline3");

      const result = await runReplace({
        path: "test.txt",
        pattern: "line1\\nline2",
        replacement: "replaced",
        caseSensitive: false,
        multiline: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(1);
    });
  });

  describe("pattern requirement for line operations", () => {
    it("should not require pattern for deleteLines with single integer", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        deleteLines: 2,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline3");
    });

    it("should not require pattern for deleteLines with array", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4");

      const result = await runReplace({
        path: "test.txt",
        deleteLines: [2, 4],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline3");
    });

    it("should not require pattern for deleteLines with range object", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4");

      const result = await runReplace({
        path: "test.txt",
        deleteLines: { start: 2, end: 3 },
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline4");
    });
  });

  describe("fixedStrings mode", () => {
    it("should replace literal text with regex metacharacters", async () => {
      writeFileSync(testFilePath, "foo (bar) [baz] + qux");

      const result = await runReplace({
        path: "test.txt",
        pattern: "(bar) [baz]",
        replacement: "replaced",
        fixedStrings: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(1);
      expect(readFileSync(testFilePath, "utf8")).toBe("foo replaced + qux");
    });

    it("should replace literal text with dots", async () => {
      writeFileSync(testFilePath, "file.txt has a dot");

      const result = await runReplace({
        path: "test.txt",
        pattern: "file.txt",
        replacement: "document.txt",
        fixedStrings: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(1);
      expect(readFileSync(testFilePath, "utf8")).toBe("document.txt has a dot");
    });

    it("should replace literal text with stars and plus", async () => {
      writeFileSync(testFilePath, "a + b * c");

      const result = await runReplace({
        path: "test.txt",
        pattern: "+ b *",
        replacement: "- d -",
        fixedStrings: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(1);
      expect(readFileSync(testFilePath, "utf8")).toBe("a - d - c");
    });

    it("should escape all regex metacharacters", async () => {
      writeFileSync(testFilePath, "a+b*c?d.e(f)g[h]i{j}k^l$m|n");

      const result = await runReplace({
        path: "test.txt",
        pattern: "a+b*c?d.e(f)g[h]i{j}k^l$m|n",
        replacement: "replaced",
        fixedStrings: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(1);
      expect(readFileSync(testFilePath, "utf8")).toBe("replaced");
    });
  });

  describe("zero-match early return", () => {
    it("should return replacements: 0 when pattern is not found", async () => {
      writeFileSync(testFilePath, "hello world");

      const result = await runReplace({
        path: "test.txt",
        pattern: "nonexistent",
        replacement: "anything",
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(0);
    });

    it("should not modify the file when pattern is not found", async () => {
      writeFileSync(testFilePath, "hello world");

      await runReplace({
        path: "test.txt",
        pattern: "nonexistent",
        replacement: "anything",
      });

      expect(readFileSync(testFilePath, "utf8")).toBe("hello world");
    });
  });

  describe("existing functionality", () => {
    it("should still work with basic pattern replacement", async () => {
      writeFileSync(testFilePath, "hello world");

      const result = await runReplace({
        path: "test.txt",
        pattern: "world",
        replacement: "universe",
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(1);
      expect(readFileSync(testFilePath, "utf8")).toBe("hello universe");
    });

    it("should still respect case sensitivity", async () => {
      writeFileSync(testFilePath, "Hello world");

      const result = await runReplace({
        path: "test.txt",
        pattern: "hello",
        replacement: "goodbye",
        caseSensitive: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(0);
      expect(readFileSync(testFilePath, "utf8")).toBe("Hello world");
    });
  });
});
