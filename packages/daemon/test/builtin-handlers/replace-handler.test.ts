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

      const result = await runReplace({
        path: "test.txt",
        pattern: "nonexistent",
        replacement: "anything",
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.replacements).toBe(0);
      expect(readFileSync(testFilePath, "utf8")).toBe("hello world");
    });
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

  describe("changed_lines return value", () => {
    describe("deleteLines", () => {
      it("returns {line: N} for a single line deletion", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

        const result = await runReplace({ path: "test.txt", deleteLines: 3 });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        // Deleted line 3; lines 4-5 shift up to 3-4
        const entries = parsed.changed_lines;
        expect(entries).toEqual(expect.arrayContaining([{ line: 3 }]));
        // The original line 4 (now at position 3) and line 5 (now at 4) are also affected
        expect(entries.length).toBeGreaterThan(1);
      });

      it("returns individual {line: N} entries for non-contiguous array delete", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

        const result = await runReplace({ path: "test.txt", deleteLines: [2, 4] });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        // Deleted lines 2 and 4; both are isolated deletions so they appear as {line: N}
        const lineEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "line" in e,
        );
        expect(lineEntries).toEqual(expect.arrayContaining([{ line: 2 }, { line: 4 }]));
      });

      it("returns {start, end} range for contiguous range delete", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

        const result = await runReplace({ path: "test.txt", deleteLines: { start: 3, end: 5 } });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        const rangeEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "start" in e,
        );
        // The deleted range itself should be a {start, end} entry
        expect(rangeEntries.length).toBeGreaterThan(0);
        const hasDeletedRange = rangeEntries.some((e: any) => e.start === 3 && e.end === 5);
        expect(hasDeletedRange).toBe(true);
      });

      it("includes shifted lines for deleteLines", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

        const result = await runReplace({ path: "test.txt", deleteLines: { start: 3, end: 5 } });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        // After deleting lines 3-5, original lines 6 and 7 shift to positions 3 and 4.
        // Those should be in changed_lines too.
        const lineEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "line" in e,
        );
        const allLineNumbers = lineEntries.map((e: any) => e.line);
        expect(allLineNumbers).toEqual(expect.arrayContaining([3, 4]));
      });
    });

    describe("replaceRange", () => {
      it("returns the new content range when replacing 3 lines with 5 new lines", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

        const result = await runReplace({
          path: "test.txt",
          replaceRange: { start: 2, end: 4 },
          replacement: "new1\nnew2\nnew3\nnew4\nnew5",
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        expect(parsed.changed_lines).toBeDefined();
        const rangeEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "start" in e,
        );
        // First range: the new content (5 new lines at positions 2-6)
        expect(rangeEntries[0]).toEqual({ start: 2, end: 6 });
      });

      it("includes shifted lines for replaceRange", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

        const result = await runReplace({
          path: "test.txt",
          replaceRange: { start: 2, end: 4 },
          replacement: "new1\nnew2\nnew3\nnew4\nnew5",
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        const rangeEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "start" in e,
        );
        // Second range: original lines 5-7 shift to positions 7-9
        expect(rangeEntries[1]).toEqual({ start: 7, end: 9 });
      });

      it("handles shrinking replacement (3 lines -> 1 line)", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

        const result = await runReplace({
          path: "test.txt",
          replaceRange: { start: 2, end: 4 },
          replacement: "newonly",
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        const rangeEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "start" in e,
        );
        // First range: just the new 1-line content at position 2
        expect(rangeEntries[0]).toEqual({ start: 2, end: 2 });
        // Second range: original lines 5-7 shift to positions 3-5
        expect(rangeEntries[1]).toEqual({ start: 3, end: 5 });
      });

      it("returns changed_lines for dryRun", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

        const result = await runReplace({
          path: "test.txt",
          replaceRange: { start: 1, end: 2 },
          replacement: "replaced",
          dryRun: true,
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.preview).toBeDefined();
        expect(parsed.changed_lines).toBeDefined();
        expect(parsed.changed_lines.length).toBeGreaterThan(0);
      });
    });

    describe("fixedStrings", () => {
      it("returns line numbers where matches occurred", async () => {
        writeFileSync(testFilePath, "hello world\nfoo bar\nhello again");

        const result = await runReplace({
          path: "test.txt",
          pattern: "hello",
          replacement: "goodbye",
          fixedStrings: true,
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.replacements).toBe(2);
        expect(parsed.changed_lines).toBeDefined();
        const lineEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "line" in e,
        );
        const allLineNumbers = lineEntries.map((e: any) => e.line);
        expect(allLineNumbers).toEqual(expect.arrayContaining([1, 3]));
      });

      it("honors maxOccurrences", async () => {
        writeFileSync(testFilePath, "hello world\nhello again\nhello last");

        const result = await runReplace({
          path: "test.txt",
          pattern: "hello",
          replacement: "goodbye",
          fixedStrings: true,
          maxOccurrences: 1,
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.replacements).toBe(1);
        const lineEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "line" in e,
        );
        const allLineNumbers = lineEntries.map((e: any) => e.line);
        expect(allLineNumbers).toEqual([1]);
      });

      it("returns empty changed_lines when no matches found", async () => {
        writeFileSync(testFilePath, "no matches here");

        const result = await runReplace({
          path: "test.txt",
          pattern: "nonexistent",
          replacement: "anything",
          fixedStrings: true,
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.replacements).toBe(0);
        expect(parsed.changed_lines).toEqual([]);
      });
    });

    describe("standard regex", () => {
      it("returns line numbers for regex matches", async () => {
        writeFileSync(testFilePath, "line1 foo\nline2 bar\nline3 foo");

        const result = await runReplace({
          path: "test.txt",
          pattern: "foo",
          replacement: "baz",
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.replacements).toBe(2);
        expect(parsed.changed_lines).toBeDefined();
        const lineEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "line" in e,
        );
        const allLineNumbers = lineEntries.map((e: any) => e.line);
        expect(allLineNumbers).toEqual(expect.arrayContaining([1, 3]));
      });

      it("honors maxOccurrences for standard regex", async () => {
        writeFileSync(testFilePath, "foo bar foo baz foo");

        const result = await runReplace({
          path: "test.txt",
          pattern: "foo",
          replacement: "replaced",
          maxOccurrences: 1,
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.replacements).toBe(1);
        const lineEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "line" in e,
        );
        const allLineNumbers = lineEntries.map((e: any) => e.line);
        expect(allLineNumbers).toEqual([1]);
      });

      it("returns empty changed_lines when no regex matches found", async () => {
        writeFileSync(testFilePath, "no matches here");

        const result = await runReplace({
          path: "test.txt",
          pattern: "nonexistent",
          replacement: "anything",
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.replacements).toBe(0);
        expect(parsed.changed_lines).toEqual([]);
      });
    });
  });
});

describe("replacement counts", () => {
  let registry: BuiltinToolRegistry;
  let workspacePath: string;
  let testFilePath: string;
  let ctx: BuiltinToolContext;

  beforeEach(() => {
    registry = new BuiltinToolRegistry();
    register(registry);

    workspacePath = mkdtempSync(join(tmpdir(), "shoggoth-test-count-"));
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

  it("regex: returns replacements: 3 when pattern matches 3 times", async () => {
    writeFileSync(testFilePath, "foo a\nfoo b\nfoo c\nother");

    const result = await runReplace({
      path: "test.txt",
      pattern: "foo",
      replacement: "bar",
    });

    const parsed = JSON.parse(result.resultJson);
    expect(parsed.replacements).toBe(3);
  });

  it("fixedStrings: returns replacements: 2", async () => {
    writeFileSync(testFilePath, "hello world\nfoo bar\nhello again");

    const result = await runReplace({
      path: "test.txt",
      pattern: "hello",
      replacement: "goodbye",
      fixedStrings: true,
    });

    const parsed = JSON.parse(result.resultJson);
    expect(parsed.replacements).toBe(2);
  });

  it("deleteLines (single number): returns replacements: 1 and keeps linesDeleted", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3");

    const result = await runReplace({ path: "test.txt", deleteLines: 2 });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.replacements).toBe(1);
    expect(parsed.linesDeleted).toEqual([2]);
  });

  it("deleteLines (range): returns replacements: 3 for {start: 5, end: 7}", async () => {
    writeFileSync(testFilePath, "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8");

    const result = await runReplace({
      path: "test.txt",
      deleteLines: { start: 5, end: 7 },
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.replacements).toBe(3);
    expect(parsed.linesDeleted).toEqual([5, 6, 7]);
  });

  it("deleteLines with dryRun: same shape", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3");

    const result = await runReplace({ path: "test.txt", deleteLines: 2, dryRun: true });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.replacements).toBe(1);
    expect(parsed.linesDeleted).toEqual([2]);
  });

  it("replaceRange: returns replacements: 1 and preserves changed_lines", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

    const result = await runReplace({
      path: "test.txt",
      replaceRange: { start: 2, end: 3 },
      replacement: "new",
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.replacements).toBe(1);
    expect(parsed.changed_lines).toBeDefined();
  });

  it("replaceRange with dryRun: same shape", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

    const result = await runReplace({
      path: "test.txt",
      replaceRange: { start: 2, end: 3 },
      replacement: "new",
      dryRun: true,
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.replacements).toBe(1);
    expect(parsed.changed_lines).toBeDefined();
  });

  it("replaceRange edge: multi-line replacement still reports replacements: 1", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

    const result = await runReplace({
      path: "test.txt",
      replaceRange: { start: 2, end: 2 },
      replacement: "a\nb\nc",
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.replacements).toBe(1);
  });
});
