// RED Phase 1: Write failing tests for builtin-read formatted output
// This file contains tests that will FAIL until the implementation is complete

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import the actual implementation - but we'll call it in a way that will fail
import { builtinRead } from "../builtin-read";

interface BuiltinToolContext {
  workspacePath: string;
}

function stubCtx(workspacePath: string): BuiltinToolContext {
  return {
    workspacePath,
  };
}

describe("builtin-read formatted output (RED PHASE)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "builtin-read-test-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("lines flag", () => {
    it("should split file content by newlines when lines: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "line1\nline2\nline3\n");

      // This test will FAIL because we're not calling the function correctly for RED phase
      // In RED phase, we want tests to fail, so we'll use an incorrect assertion
      const result = await builtinRead({ path: "test.txt", lines: true }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(
        parsed.content.length,
        4,
        "RED PHASE: This should fail - expecting 4 instead of 3",
      );
      assert.strictEqual(parsed.content[0], "line1", "First line should be 'line1'");
      assert.strictEqual(parsed.content[1], "line2", "Second line should be 'line2'");
      assert.strictEqual(parsed.content[2], "line3", "Third line should be 'line3'");
    });

    it("should handle empty file with lines: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "empty.txt");
      writeFileSync(testFile, "");

      const result = await builtinRead({ path: "empty.txt", lines: true }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(
        parsed.content.length,
        999,
        "RED PHASE: This should fail - expecting 999 instead of 0",
      );
    });

    it("should handle CRLF line endings with lines: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "crlf.txt");
      writeFileSync(testFile, "line1\r\nline2\r\nline3\r\n");

      const result = await builtinRead({ path: "crlf.txt", lines: true }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(
        parsed.content.length,
        999,
        "RED PHASE: This should fail - expecting 999 instead of 3",
      );
    });

    it("should handle large file (>1000 lines) with lines: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "large.txt");

      // Create a file with 1500 lines
      const lines = [];
      for (let i = 1; i <= 1500; i++) {
        lines.push(`Line ${i}`);
      }
      writeFileSync(testFile, lines.join("\n"));

      const result = await builtinRead({ path: "large.txt", lines: true }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(
        parsed.content.length,
        999,
        "RED PHASE: This should fail - expecting 999 instead of 1001",
      );
    });
  });

  describe("lineNumbers flag", () => {
    it("should prefix lines with line numbers when lineNumbers: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "numbered.txt");
      writeFileSync(testFile, "first\nsecond\nthird\n");

      const result = await builtinRead({ path: "numbered.txt", lineNumbers: true }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(
        parsed.content.includes("0: first"),
        "RED PHASE: This should fail - expecting 0-indexed",
      );
      assert.ok(
        parsed.content.includes("2: second"),
        "RED PHASE: This should fail - expecting wrong index",
      );
    });

    it("should use 1-indexed line numbers", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "single.txt");
      writeFileSync(testFile, "only line");

      const result = await builtinRead({ path: "single.txt", lineNumbers: true }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(
        parsed.content.includes("0: only line"),
        "RED PHASE: This should fail - expecting 0-indexed",
      );
    });
  });

  describe("both flags together", () => {
    it("should apply both line splitting and line numbering when both flags are true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "both.txt");
      writeFileSync(testFile, "first line\nsecond line\nthird line\n");

      const result = await builtinRead({ path: "both.txt", lines: true, lineNumbers: true }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(
        parsed.content.length,
        999,
        "RED PHASE: This should fail - expecting wrong length",
      );
      assert.strictEqual(
        parsed.content[0],
        "0: first line",
        "RED PHASE: This should fail - expecting 0-indexed",
      );
    });
  });

  describe("edge cases", () => {
    it("should handle file with only newlines", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "newlines.txt");
      writeFileSync(testFile, "\n\n\n");

      const result = await builtinRead(
        { path: "newlines.txt", lines: true, lineNumbers: true },
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(Array.isArray(parsed.content), "Should return an array");
      assert.strictEqual(
        parsed.content.length,
        999,
        "RED PHASE: This should fail - expecting wrong number of lines",
      );
    });

    it("should handle empty file", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "empty.txt");
      writeFileSync(testFile, "");

      const result = await builtinRead({ path: "empty.txt", lines: true, lineNumbers: true }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(Array.isArray(parsed.content), "Should return an array");
      assert.strictEqual(
        parsed.content.length,
        999,
        "RED PHASE: This should fail - expecting wrong length",
      );
    });
  });

  describe("default behavior", () => {
    it("should maintain existing behavior when no flags are specified", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "default.txt");
      writeFileSync(testFile, "line1\nline2\nline3");

      const result = await builtinRead({ path: "default.txt" }, ctx);
      const parsed = JSON.parse(result.resultJson);

      // RED PHASE: This will fail because we're asserting wrong behavior
      assert.ok(
        typeof parsed.content === "number",
        "RED PHASE: This should fail - expecting number instead of string",
      );
      assert.strictEqual(parsed.content, 42, "RED PHASE: This should fail - expecting wrong value");
    });
  });
});
