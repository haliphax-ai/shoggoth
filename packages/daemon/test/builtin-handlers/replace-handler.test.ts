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

  describe("positional edits don't require pattern", () => {
    it("should not require pattern for single positional delete", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        start: 2,
        end: 2,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline3");
    });

    it("should not require pattern for batch deletes", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4");

      const result = await runReplace({
        path: "test.txt",
        edits: [
          { start: 2, end: 2 },
          { start: 4, end: 4 },
        ],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline3");
    });

    it("should not require pattern for positional range delete", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4");

      const result = await runReplace({
        path: "test.txt",
        start: 2,
        end: 3,
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
    describe("positional delete", () => {
      it("returns shifted range for a single line deletion", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

        const result = await runReplace({ path: "test.txt", start: 3, end: 3 });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        expect(parsed.edits_applied).toBe(1);
        // Deleting line 3: lines 4-5 shift to positions 3-4
        const rangeEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "start" in e,
        );
        expect(rangeEntries).toEqual([{ start: 3, end: 4 }]);
      });

      it("returns correct range for batch delete of non-contiguous lines", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

        const result = await runReplace({
          path: "test.txt",
          edits: [
            { start: 2, end: 2 },
            { start: 4, end: 4 },
          ],
        });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        expect(parsed.edits_applied).toBe(2);
        expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline3\nline5");
      });

      it("returns shifted range for contiguous range delete", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

        const result = await runReplace({ path: "test.txt", start: 3, end: 5 });
        const parsed = JSON.parse(result.resultJson);

        expect(parsed.success).toBe(true);
        // After deleting lines 3-5, original lines 6-7 shift to positions 3-4
        const rangeEntries = parsed.changed_lines.filter(
          (e: any) => typeof e === "object" && "start" in e,
        );
        expect(rangeEntries).toEqual([{ start: 3, end: 4 }]);
      });
    });

    describe("positional replace", () => {
      it("returns the new content range when replacing 3 lines with 5 new lines", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

        const result = await runReplace({
          path: "test.txt",
          start: 2,
          end: 4,
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

      it("includes shifted lines for positional replace", async () => {
        writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

        const result = await runReplace({
          path: "test.txt",
          start: 2,
          end: 4,
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
          start: 2,
          end: 4,
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
          start: 1,
          end: 2,
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

  describe("batch edits mode", () => {
    it("applies two non-overlapping replace edits in one batch", async () => {
      writeFileSync(testFilePath, "a\nb\nc\nd\ne\nf\ng");

      const result = await runReplace({
        path: "test.txt",
        edits: [
          { start: 2, end: 3, replacement: "B\nC" },
          { start: 5, end: 6, replacement: "E\nF" },
        ],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("a\nB\nC\nd\nE\nF\ng");
    });

    it("applies a mixed batch of delete and replace edits", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

      const result = await runReplace({
        path: "test.txt",
        edits: [
          { start: 2, end: 3, replacement: "TWO" },
          { start: 7, end: 7 },
        ],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nTWO\nline4\nline5\nline6");
    });

    it("applies edits bottom-up even when lower line numbers are listed first", async () => {
      writeFileSync(testFilePath, "a\nb\nc\nd\ne\nf\ng");

      const result = await runReplace({
        path: "test.txt",
        edits: [
          { start: 2, end: 3, replacement: "B" },
          { start: 5, end: 6, replacement: "E" },
        ],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("a\nB\nd\nE\ng");
    });

    it("rejects edits with overlapping line ranges", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

      const result = await runReplace({
        path: "test.txt",
        edits: [
          { start: 2, end: 4, replacement: "x" },
          { start: 4, end: 5, replacement: "y" },
        ],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/overlap/i);
      expect(readFileSync(testFilePath, "utf8")).toBe(
        "line1\nline2\nline3\nline4\nline5\nline6\nline7",
      );
    });

    it("rejects an edit with a start line beyond the file length", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5\nline6\nline7");

      const result = await runReplace({
        path: "test.txt",
        edits: [{ start: 9, end: 10, replacement: "x" }],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/beyond/i);
      expect(readFileSync(testFilePath, "utf8")).toBe(
        "line1\nline2\nline3\nline4\nline5\nline6\nline7",
      );
    });

    it("rejects edits combined with pattern", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        pattern: "line",
        replacement: "LINE",
        edits: [{ start: 2, end: 2, replacement: "new" }],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/mutually exclusive/i);
    });

    it("rejects edits combined with start/end", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        start: 2,
        end: 2,
        edits: [{ start: 2, end: 2, replacement: "new" }],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/mutually exclusive/i);
    });

    it("rejects an empty edits array", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        edits: [],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/empty/i);
    });

    it("applies a single edit in the array like a normal edit", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        edits: [{ start: 2, end: 2, replacement: "NEW" }],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nNEW\nline3");
    });

    it("splits multi-line replacement content correctly", async () => {
      writeFileSync(testFilePath, "l1\nl2\nl3\nl4\nl5");

      const result = await runReplace({
        path: "test.txt",
        edits: [{ start: 2, end: 2, replacement: "a\nb\nc" }],
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("l1\na\nb\nc\nl3\nl4\nl5");
    });

    it("returns a preview and does not modify the file when dryRun is true", async () => {
      writeFileSync(testFilePath, "l1\nl2\nl3\nl4\nl5");

      const result = await runReplace({
        path: "test.txt",
        edits: [{ start: 2, end: 3, replacement: "NEW" }],
        dryRun: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.preview).toBeDefined();
      expect(parsed.preview).toBe("l1\nNEW\nl4\nl5");
      expect(readFileSync(testFilePath, "utf8")).toBe("l1\nl2\nl3\nl4\nl5");
    });
  });

  describe("single positional edits", () => {
    it("deletes a range when replacement is absent", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

      const result = await runReplace({
        path: "test.txt",
        start: 2,
        end: 3,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(parsed.edits_applied).toBe(1);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline4\nline5");
    });

    it("replaces a range when replacement is present", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

      const result = await runReplace({
        path: "test.txt",
        start: 2,
        end: 3,
        replacement: "NEW",
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(parsed.edits_applied).toBe(1);
      expect(readFileSync(testFilePath, "utf8")).toBe("line1\nNEW\nline4\nline5");
    });

    it("handles multi-line replacement content", async () => {
      writeFileSync(testFilePath, "l1\nl2\nl3\nl4\nl5");

      const result = await runReplace({
        path: "test.txt",
        start: 2,
        end: 2,
        replacement: "a\nb\nc",
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.success).toBe(true);
      expect(readFileSync(testFilePath, "utf8")).toBe("l1\na\nb\nc\nl3\nl4\nl5");
    });

    it("rejects start without end", async () => {
      const result = await runReplace({
        path: "test.txt",
        start: 2,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/start and end/i);
    });

    it("rejects end without start", async () => {
      const result = await runReplace({
        path: "test.txt",
        end: 3,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/start and end/i);
    });

    it("rejects start > end", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        start: 5,
        end: 2,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/start must be <= end/i);
    });

    it("rejects start beyond file length", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        start: 10,
        end: 12,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/beyond/i);
    });

    it("rejects positional edit combined with pattern", async () => {
      writeFileSync(testFilePath, "line1\nline2\nline3");

      const result = await runReplace({
        path: "test.txt",
        start: 1,
        end: 3,
        pattern: "line",
        replacement: "LINE",
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toMatch(/mutually exclusive/i);
    });

    it("returns a preview and does not modify the file when dryRun is true", async () => {
      writeFileSync(testFilePath, "l1\nl2\nl3\nl4\nl5");

      const result = await runReplace({
        path: "test.txt",
        start: 2,
        end: 3,
        replacement: "NEW",
        dryRun: true,
      });

      const parsed = JSON.parse(result.resultJson);
      expect(parsed.preview).toBeDefined();
      expect(parsed.preview).toBe("l1\nNEW\nl4\nl5");
      expect(readFileSync(testFilePath, "utf8")).toBe("l1\nl2\nl3\nl4\nl5");
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

  it("positional delete (single line): returns edits_applied: 1", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3");

    const result = await runReplace({ path: "test.txt", start: 2, end: 2 });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.edits_applied).toBe(1);
    expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline3");
  });

  it("positional delete (range): returns edits_applied: 1", async () => {
    writeFileSync(testFilePath, "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8");

    const result = await runReplace({
      path: "test.txt",
      start: 5,
      end: 7,
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.edits_applied).toBe(1);
    expect(readFileSync(testFilePath, "utf8")).toBe("l1\nl2\nl3\nl4\nl8");
  });

  it("positional delete with dryRun: same shape", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3");

    const result = await runReplace({ path: "test.txt", start: 2, end: 2, dryRun: true });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.edits_applied).toBe(1);
    expect(parsed.preview).toBeDefined();
    // File should not be modified
    expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline2\nline3");
  });

  it("positional replace: returns edits_applied: 1", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

    const result = await runReplace({
      path: "test.txt",
      start: 2,
      end: 3,
      replacement: "new",
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.edits_applied).toBe(1);
    expect(readFileSync(testFilePath, "utf8")).toBe("line1\nnew\nline4\nline5");
  });

  it("positional replace with dryRun: same shape", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

    const result = await runReplace({
      path: "test.txt",
      start: 2,
      end: 3,
      replacement: "new",
      dryRun: true,
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.edits_applied).toBe(1);
    expect(parsed.preview).toBeDefined();
    expect(readFileSync(testFilePath, "utf8")).toBe("line1\nline2\nline3\nline4\nline5");
  });

  it("positional replace edge: multi-line replacement still reports edits_applied: 1", async () => {
    writeFileSync(testFilePath, "line1\nline2\nline3\nline4\nline5");

    const result = await runReplace({
      path: "test.txt",
      start: 2,
      end: 2,
      replacement: "a\nb\nc",
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.edits_applied).toBe(1);
  });

  it("batch edits: returns edits_applied: 2 for two edits", async () => {
    writeFileSync(testFilePath, "a\nb\nc\nd\ne");

    const result = await runReplace({
      path: "test.txt",
      edits: [
        { start: 1, end: 1, replacement: "A" },
        { start: 5, end: 5, replacement: "E" },
      ],
    });
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.edits_applied).toBe(2);
    expect(readFileSync(testFilePath, "utf8")).toBe("A\nb\nc\nd\nE");
  });
});
