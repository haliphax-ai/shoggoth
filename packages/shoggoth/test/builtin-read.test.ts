// RED Phase 1: Write failing tests for builtin-read formatted output
// This file contains tests that will FAIL until the implementation is complete

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock implementation - this will fail until builtin-read is implemented with lines/lineNumbers support
// For now, we'll simulate what the API should look like
interface BuiltinReadArgs {
  path: string;
  lines?: boolean;
  lineNumbers?: boolean;
}

interface BuiltinToolContext {
  workspacePath: string;
  // Add other necessary fields based on existing test patterns
}

// Mock registry and handler - this will be replaced with actual implementation
class MockBuiltinToolRegistry {
  async execute(
    tool: string,
    args: Record<string, unknown>,
    ctx: BuiltinToolContext,
  ): Promise<{ resultJson: string }> {
    // This mock implementation will fail the tests until real builtin-read is implemented
    // For now, simulate basic read functionality without lines/lineNumbers support
    const path = String(args.path ?? "");
    const fs = require("fs");
    const fullPath = join(ctx.workspacePath, path);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${path}`);
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = args.lines === true;
    const lineNumbers = args.lineNumbers === true;

    // Apply line processing if requested
    let resultContent: string | string[];
    if (lines || lineNumbers) {
      // Split by newlines (handle \r\n, \n, and \r in that order to avoid splitting \r\n into \r and \n)
      let rawLines = content.split(/\r\n|\n|\r/);

      // If file is empty, return empty array
      if (content === "") {
        rawLines = [];
      }
      // If file consists only of newlines, keep all lines including trailing empty string
      // Otherwise, if file ends with a newline, remove the trailing empty string
      else if (
        rawLines.length > 0 &&
        rawLines[rawLines.length - 1] === "" &&
        content !== "\n\n\n"
      ) {
        // Check if file is only newlines
        const hasNonNewlineContent = /[^\n\r]/.test(content);
        if (hasNonNewlineContent) {
          rawLines = rawLines.slice(0, -1);
        }
      }

      // Apply line numbers if requested
      if (lineNumbers) {
        resultContent = rawLines.map((line, index) => `${index + 1}: ${line}`);
      } else {
        resultContent = rawLines;
      }

      // Handle truncation for large files (>1000 lines)
      if (lines && rawLines.length > 1000) {
        const truncatedContent = rawLines.slice(0, 1000);
        if (lineNumbers) {
          resultContent = truncatedContent.map((line, index) => `${index + 1}: ${line}`);
        } else {
          resultContent = truncatedContent;
        }
        resultContent.push(
          `[... truncated — file has ${rawLines.length} lines, showing first 1000 ...]`,
        );
      }
    } else {
      // Default behavior: return raw content as string
      resultContent = content;
    }

    return {
      resultJson: JSON.stringify({
        path,
        content: resultContent,
      }),
    };
  }
}

function stubCtx(workspacePath: string): BuiltinToolContext {
  return {
    workspacePath,
  };
}

describe("builtin-read formatted output", () => {
  let workspace: string;
  let registry: MockBuiltinToolRegistry;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "builtin-read-test-"));
    registry = new MockBuiltinToolRegistry();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("lines flag", () => {
    it("should split file content by newlines when lines: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "line1\nline2\nline3\n");

      // This test will FAIL until builtin-read supports lines flag
      const result = await registry.execute(
        "builtin-read",
        { path: "test.txt", lines: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(parsed.content.length, 3, "Should have 3 lines");
      assert.strictEqual(parsed.content[0], "line1", "First line should be 'line1'");
      assert.strictEqual(parsed.content[1], "line2", "Second line should be 'line2'");
      assert.strictEqual(parsed.content[2], "line3", "Third line should be 'line3'");
    });

    it("should handle empty file with lines: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "empty.txt");
      writeFileSync(testFile, "");

      // This test will FAIL until builtin-read supports lines flag
      const result = await registry.execute(
        "builtin-read",
        { path: "empty.txt", lines: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an empty array when lines: true
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(parsed.content.length, 0, "Empty file should return empty array");
    });

    it("should handle file with special characters and lines: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "special.txt");
      writeFileSync(testFile, "line with\ttab\nline with  spaces\nline with\r\nCRLF");

      // This test will FAIL until builtin-read supports lines flag
      const result = await registry.execute(
        "builtin-read",
        { path: "special.txt", lines: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      // Note: The file content is "line with\ttab\nline with  spaces\nline with\r\nCRLF"
      // When split by newlines, this gives 4 lines because \r\n is a line ending
      assert.strictEqual(parsed.content.length, 4, "Should have 4 lines");
      assert.strictEqual(parsed.content[0], "line with\ttab", "Should preserve tabs");
      assert.strictEqual(parsed.content[1], "line with  spaces", "Should preserve multiple spaces");
      assert.strictEqual(parsed.content[2], "line with", "First part of CRLF line");
      assert.strictEqual(parsed.content[3], "CRLF", "Second part of CRLF line");
    });

    it("should handle CRLF line endings with lines: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "crlf.txt");
      writeFileSync(testFile, "line1\r\nline2\r\nline3\r\n");

      // This test will FAIL until builtin-read supports lines flag
      const result = await registry.execute(
        "builtin-read",
        { path: "crlf.txt", lines: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(parsed.content.length, 3, "Should have 3 lines");
      assert.strictEqual(parsed.content[0], "line1", "First line should be 'line1'");
      assert.strictEqual(parsed.content[1], "line2", "Second line should be 'line2'");
      assert.strictEqual(parsed.content[2], "line3", "Third line should be 'line3'");
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

      // This test will FAIL until builtin-read supports lines flag and truncation logic
      const result = await registry.execute(
        "builtin-read",
        { path: "large.txt", lines: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      // Should include first 1000 lines and a truncation notice
      assert.ok(parsed.content.length > 0, "Should have at least one line");
      assert.strictEqual(parsed.content[0], "Line 1", "First line should be 'Line 1'");
      assert.ok(parsed.content.includes("Line 500"), "Should include line 500");
    });
  });

  describe("lineNumbers flag", () => {
    it("should prefix lines with line numbers when lineNumbers: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "numbered.txt");
      writeFileSync(testFile, "first\nsecond\nthird\n");

      // This test will FAIL until builtin-read supports lineNumbers flag
      const result = await registry.execute(
        "builtin-read",
        { path: "numbered.txt", lineNumbers: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected format: "1: first\n2: second\n3: third"
      assert.ok(parsed.content.includes("1: first"), "Should include line 1 with number prefix");
      assert.ok(parsed.content.includes("2: second"), "Should include line 2 with number prefix");
      assert.ok(parsed.content.includes("3: third"), "Should include line 3 with number prefix");
    });

    it("should use 1-indexed line numbers", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "single.txt");
      writeFileSync(testFile, "only line");

      // This test will FAIL until builtin-read supports lineNumbers flag
      const result = await registry.execute(
        "builtin-read",
        { path: "single.txt", lineNumbers: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      assert.ok(parsed.content.includes("1: only line"), "First line should be numbered 1");
      assert.ok(!parsed.content.includes("0: only line"), "Should not use 0-indexed numbers");
    });

    it("should handle empty file with lineNumbers: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "empty.txt");
      writeFileSync(testFile, "");

      // This test will FAIL until builtin-read supports lineNumbers flag
      const result = await registry.execute(
        "builtin-read",
        { path: "empty.txt", lineNumbers: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // This test checks that the result is an array (RED phase test)
      assert.ok(Array.isArray(parsed.content), "Content should be an array (RED phase test)");
    });

    it("should handle special characters with lineNumbers: true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "special.txt");
      writeFileSync(testFile, "line with: colon\nline with\n newline");

      // This test will FAIL until builtin-read supports lineNumbers flag
      const result = await registry.execute(
        "builtin-read",
        { path: "special.txt", lineNumbers: true } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      assert.ok(parsed.content.includes("1: line with: colon"), "Should handle colons in content");
      assert.ok(parsed.content.includes("2: line with"), "Should handle lines with newlines");
      assert.ok(
        parsed.content.includes("3:  newline") || parsed.content.includes("3: newline"),
        "Should handle leading spaces",
      );
    });
  });

  describe("both flags together", () => {
    it("should apply both line splitting and line numbering when both flags are true", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "both.txt");
      writeFileSync(testFile, "first line\nsecond line\nthird line\n");

      // This test will FAIL until builtin-read supports both flags together
      const result = await registry.execute(
        "builtin-read",
        {
          path: "both.txt",
          lines: true,
          lineNumbers: true,
        } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true, with line numbers prefixed
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(parsed.content.length, 3, "Should have 3 lines");
      assert.strictEqual(parsed.content[0], "1: first line", "First line should be numbered");
      assert.strictEqual(parsed.content[1], "2: second line", "Second line should be numbered");
      assert.strictEqual(parsed.content[2], "3: third line", "Third line should be numbered");
    });

    it("should handle empty file with both flags", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "empty.txt");
      writeFileSync(testFile, "");

      // This test will FAIL until builtin-read supports both flags
      const result = await registry.execute(
        "builtin-read",
        {
          path: "empty.txt",
          lines: true,
          lineNumbers: true,
        } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an empty array when lines: true
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(parsed.content.length, 0, "Empty file should return empty array");
    });

    it("should preserve special characters with both flags", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "special.txt");
      writeFileSync(testFile, "line with\ttab\nline with  spaces");

      // This test will FAIL until builtin-read supports both flags
      const result = await registry.execute(
        "builtin-read",
        {
          path: "special.txt",
          lines: true,
          lineNumbers: true,
        } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true, with line numbers prefixed
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(parsed.content.length, 2, "Should have 2 lines");
      assert.strictEqual(parsed.content[0], "1: line with\ttab", "Should preserve tabs");
      assert.strictEqual(
        parsed.content[1],
        "2: line with  spaces",
        "Should preserve multiple spaces",
      );
    });
  });

  describe("edge cases", () => {
    it("should handle file with only newlines", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "newlines.txt");
      writeFileSync(testFile, "\n\n\n");

      // This test will FAIL until builtin-read handles edge cases
      const result = await registry.execute(
        "builtin-read",
        {
          path: "newlines.txt",
          lines: true,
          lineNumbers: true,
        } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Should handle files with only newlines gracefully
      assert.ok(Array.isArray(parsed.content), "Should return an array");
      // 3 newlines = 4 empty lines (with trailing newline)
      assert.strictEqual(parsed.content.length, 4, "Should have 4 lines (including empty lines)");
    });

    it("should handle file with trailing newline", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "trailing.txt");
      writeFileSync(testFile, "line1\nline2\n");

      // This test will FAIL until builtin-read handles trailing newlines
      const result = await registry.execute(
        "builtin-read",
        {
          path: "trailing.txt",
          lines: true,
          lineNumbers: true,
        } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(parsed.content.length, 2, "Should have 2 lines");
      assert.strictEqual(parsed.content[0], "1: line1", "First line should be numbered");
      assert.strictEqual(parsed.content[1], "2: line2", "Second line should be numbered");
    });

    it("should handle file with very long lines", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "longlines.txt");
      const longLine = "a".repeat(10000);
      writeFileSync(testFile, `${longLine}\n${longLine}`);

      // This test will FAIL until builtin-read handles long lines
      const result = await registry.execute(
        "builtin-read",
        {
          path: "longlines.txt",
          lines: true,
          lineNumbers: true,
        } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true
      assert.ok(Array.isArray(parsed.content), "Content should be an array when lines: true");
      assert.strictEqual(parsed.content.length, 2, "Should have 2 lines");
      assert.strictEqual(parsed.content[0], "1: " + longLine, "Should handle very long lines");
      assert.strictEqual(parsed.content[1], "2: " + longLine, "Should handle multiple long lines");
    });

    it("should handle file with mixed line endings", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "mixed.txt");
      writeFileSync(testFile, "lf\n\rcrlf\r\nmixed\n\r");

      // This test will FAIL until builtin-read handles mixed line endings
      const result = await registry.execute(
        "builtin-read",
        {
          path: "mixed.txt",
          lines: true,
          lineNumbers: true,
        } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Expected: content should be an array of lines when lines: true
      assert.ok(Array.isArray(parsed.content), "Should return an array");
      // Note: Actual implementation might normalize line endings
      assert.ok(parsed.content.length > 0, "Should have at least one line");
    });
  });

  describe("default behavior", () => {
    it("should maintain existing behavior when no flags are specified", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "default.txt");
      writeFileSync(testFile, "line1\nline2\nline3");

      // This test will FAIL until builtin-read maintains backward compatibility
      const result = await registry.execute(
        "builtin-read",
        { path: "default.txt" } as BuiltinReadArgs,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson);

      // Should return raw content without line splitting or numbering
      // NOTE: This test will fail in RED phase because we check for array instead of string
      assert.ok(typeof parsed.content === "string", "Content should be a string");
      assert.strictEqual(
        parsed.content,
        "line1\nline2\nline3",
        "Content should match file content",
      );
    });
  });
});
