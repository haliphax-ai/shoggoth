// RED Phase 6: Write failing tests for line-level operations
// This section contains tests for line deletion and range replacement that will FAIL until implementation is complete

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import the actual implementation - but we'll call it in a way that will fail
import { builtinReplace } from "../builtin-replace";

interface BuiltinToolContext {
  workspacePath: string;
}

function stubCtx(workspacePath: string): BuiltinToolContext {
  return {
    workspacePath,
  };
}

describe("builtin-replace line-level operations (RED PHASE)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "builtin-replace-line-test-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("single line deletion", () => {
    it("should delete a single line by line number", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because line deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLine: 3,
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting line 3 to be deleted
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      // Verify the line was actually deleted
      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nline 2\nline 4\nline 5\n",
        "RED PHASE: This should fail - expecting line 3 to be deleted",
      );
    });

    it("should delete first line", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because line deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLine: 1,
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting first line to be deleted
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 2\nline 3\n",
        "RED PHASE: This should fail - expecting first line to be deleted",
      );
    });

    it("should delete last line", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because line deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLine: 3,
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting last line to be deleted
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nline 2\n",
        "RED PHASE: This should fail - expecting last line to be deleted",
      );
    });
  });

  describe("range deletion (deleteRange object)", () => {
    it("should delete a range of lines", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because range deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteRange: { start: 2, end: 4 },
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 2-4 to be deleted
      assert.ok(parsed.changesMade === 3, "RED PHASE: This should fail - expecting 3 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nline 5\n",
        "RED PHASE: This should fail - expecting lines 2-4 to be deleted",
      );
    });

    it("should delete range including first line", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because range deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteRange: { start: 1, end: 2 },
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 1-2 to be deleted
      assert.ok(parsed.changesMade === 2, "RED PHASE: This should fail - expecting 2 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 3\n",
        "RED PHASE: This should fail - expecting lines 1-2 to be deleted",
      );
    });

    it("should delete range including last line", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because range deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteRange: { start: 2, end: 3 },
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 2-3 to be deleted
      assert.ok(parsed.changesMade === 2, "RED PHASE: This should fail - expecting 2 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\n",
        "RED PHASE: This should fail - expecting lines 2-3 to be deleted",
      );
    });

    it("should delete single line using range (start equals end)", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because range deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteRange: { start: 2, end: 2 },
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting line 2 to be deleted
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nline 3\n",
        "RED PHASE: This should fail - expecting line 2 to be deleted",
      );
    });
  });

  describe("multiple non-contiguous line deletions", () => {
    it("should delete multiple non-contiguous lines", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because non-contiguous deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLines: [2, 4],
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 2 and 4 to be deleted
      assert.ok(parsed.changesMade === 2, "RED PHASE: This should fail - expecting 2 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nline 3\nline 5\n",
        "RED PHASE: This should fail - expecting lines 2 and 4 to be deleted",
      );
    });

    it("should delete first and last line", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because non-contiguous deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLines: [1, 3],
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 1 and 3 to be deleted
      assert.ok(parsed.changesMade === 2, "RED PHASE: This should fail - expecting 2 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 2\n",
        "RED PHASE: This should fail - expecting lines 1 and 3 to be deleted",
      );
    });

    it("should delete three non-contiguous lines", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because non-contiguous deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLines: [1, 3, 5],
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 1, 3, and 5 to be deleted
      assert.ok(parsed.changesMade === 3, "RED PHASE: This should fail - expecting 3 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 2\nline 4\nline 6\n",
        "RED PHASE: This should fail - expecting lines 1, 3, and 5 to be deleted",
      );
    });
  });

  describe("range replacement (replaceRange object)", () => {
    it("should replace a range of lines with a single string", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because range replacement is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 2, end: 4 },
          replacement: "REPLACED",
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 2-4 to be replaced
      assert.ok(parsed.changesMade === 3, "RED PHASE: This should fail - expecting 3 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nREPLACED\nline 5\n",
        "RED PHASE: This should fail - expecting lines 2-4 to be replaced with 'REPLACED'",
      );
    });

    it("should replace a range of lines with an array of strings", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because range replacement is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 2, end: 4 },
          replacement: ["new line 2", "new line 3", "new line 4"],
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 2-4 to be replaced with array
      assert.ok(parsed.changesMade === 3, "RED PHASE: This should fail - expecting 3 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nnew line 2\nnew line 3\nnew line 4\nline 5\n",
        "RED PHASE: This should fail - expecting lines 2-4 to be replaced with array",
      );
    });

    it("should replace range with fewer lines than original", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because range replacement is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 2, end: 4 },
          replacement: ["REPLACED"],
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting lines 2-4 to be replaced with 1 line
      assert.ok(parsed.changesMade === 3, "RED PHASE: This should fail - expecting 3 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nREPLACED\nline 5\n",
        "RED PHASE: This should fail - expecting lines 2-4 to be replaced with 1 line",
      );
    });

    it("should replace range with more lines than original", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because range replacement is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 2, end: 2 },
          replacement: ["new line 2a", "new line 2b", "new line 2c"],
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting line 2 to be replaced with 3 lines
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nnew line 2a\nnew line 2b\nnew line 2c\nline 3\n",
        "RED PHASE: This should fail - expecting line 2 to be replaced with 3 lines",
      );
    });
  });

  describe("edge cases: delete entire file, replace with empty", () => {
    it("should delete entire file", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because entire file deletion is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteRange: { start: 1, end: 3 },
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting all lines to be deleted
      assert.ok(parsed.changesMade === 3, "RED PHASE: This should fail - expecting 3 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(currentContent, "", "RED PHASE: This should fail - expecting empty file");
    });

    it("should replace entire file with empty string", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because replace with empty is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 1, end: 3 },
          replacement: "",
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting all lines to be replaced with empty
      assert.ok(parsed.changesMade === 3, "RED PHASE: This should fail - expecting 3 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(currentContent, "", "RED PHASE: This should fail - expecting empty file");
    });

    it("should replace range with empty array", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because replace with empty array is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 2, end: 2 },
          replacement: [],
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting line 2 to be deleted
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nline 3\n",
        "RED PHASE: This should fail - expecting line 2 to be deleted",
      );
    });
  });

  describe("out-of-range error handling", () => {
    it("should error when deleteLine is out of range", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because out-of-range error is not handled
      await assert.rejects(
        async () =>
          await builtinReplace(
            {
              path: "test.txt",
              deleteLine: 10,
            },
            ctx,
          ),
        /out of range|invalid line number/i,
        "RED PHASE: This should fail - expecting error for out-of-range line",
      );
    });

    it("should error when deleteRange start is out of range", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because out-of-range error is not handled
      await assert.rejects(
        async () =>
          await builtinReplace(
            {
              path: "test.txt",
              deleteRange: { start: 10, end: 12 },
            },
            ctx,
          ),
        /out of range|invalid line range/i,
        "RED PHASE: This should fail - expecting error for out-of-range deleteRange",
      );
    });

    it("should error when deleteRange end is out of range", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because out-of-range error is not handled
      await assert.rejects(
        async () =>
          await builtinReplace(
            {
              path: "test.txt",
              deleteRange: { start: 1, end: 10 },
            },
            ctx,
          ),
        /out of range|invalid line range/i,
        "RED PHASE: This should fail - expecting error for out-of-range deleteRange",
      );
    });

    it("should error when deleteRange start > end", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because invalid range error is not handled
      await assert.rejects(
        async () =>
          await builtinReplace(
            {
              path: "test.txt",
              deleteRange: { start: 3, end: 1 },
            },
            ctx,
          ),
        /invalid range|start.*greater.*end/i,
        "RED PHASE: This should fail - expecting error for invalid range",
      );
    });
  });

  describe("line ending preservation", () => {
    it("should preserve line endings after deletion", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\r\nline 2\r\nline 3\r\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because line ending preservation is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLine: 2,
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting line 2 to be deleted
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\r\nline 3\r\n",
        "RED PHASE: This should fail - expecting CRLF line endings preserved",
      );
    });

    it("should preserve Unix line endings after range replacement", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because line ending preservation is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 2, end: 2 },
          replacement: "new line 2",
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting line ending preservation
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nnew line 2\nline 3\n",
        "RED PHASE: This should fail - expecting Unix line endings preserved",
      );
    });
  });

  describe("trailing newline preservation", () => {
    it("should preserve trailing newline after deletion", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because trailing newline preservation is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLine: 2,
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting trailing newline preserved
      assert.ok(parsed.changesMade === 1, "RED PHASE: This should fail - expecting 1 change");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nline 3\n",
        "RED PHASE: This should fail - expecting trailing newline preserved",
      );
    });

    it("should preserve trailing newline after range replacement", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because trailing newline preservation is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 2, end: 3 },
          replacement: ["new line 2"],
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting trailing newline preserved
      assert.ok(parsed.changesMade === 2, "RED PHASE: This should fail - expecting 2 changes");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        "line 1\nnew line 2\n",
        "RED PHASE: This should fail - expecting trailing newline preserved",
      );
    });
  });

  describe("integration with dry-run mode", () => {
    it("should show proposed line deletion in dry-run", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because dry-run with line operations is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLine: 2,
          dryRun: true,
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting dry-run output
      assert.ok(parsed.preview, "RED PHASE: This should fail - expecting preview in dry-run mode");
      assert.ok(
        parsed.preview.includes("line 2") || parsed.preview.includes("Line 2"),
        "RED PHASE: This should fail - expecting line 2 in preview",
      );

      // Verify file wasn't modified
      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        originalContent,
        "RED PHASE: This should fail - expecting file NOT modified in dry-run mode",
      );
    });

    it("should show proposed range replacement in dry-run", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because dry-run with range replacement is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          replaceRange: { start: 2, end: 2 },
          replacement: "REPLACED",
          dryRun: true,
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting dry-run output
      assert.ok(parsed.preview, "RED PHASE: This should fail - expecting preview in dry-run mode");
      assert.ok(
        parsed.preview.includes("line 2") || parsed.preview.includes("Line 2"),
        "RED PHASE: This should fail - expecting line 2 in preview",
      );

      // Verify file wasn't modified
      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        originalContent,
        "RED PHASE: This should fail - expecting file NOT modified in dry-run mode",
      );
    });

    it("should not modify file when dryRun is true with line operations", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      const originalContent = "line 1\nline 2\nline 3\n";
      writeFileSync(testFile, originalContent);

      // RED PHASE: This will fail because dry-run with line operations is not implemented
      const result = await builtinReplace(
        {
          path: "test.txt",
          deleteLines: [2],
          dryRun: true,
        },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This should fail - expecting dry-run to not modify file
      assert.ok(parsed.changesMade > 0, "RED PHASE: This should fail - expecting changes reported");

      const currentContent = readFileSync(testFile, "utf-8");
      assert.strictEqual(
        currentContent,
        originalContent,
        "RED PHASE: This should fail - expecting file NOT modified in dry-run mode",
      );
    });
  });
});
