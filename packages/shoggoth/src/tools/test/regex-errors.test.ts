// RED Phase 3: Write failing tests for regex error messages
// This file contains tests that will FAIL until the regex error handling is improved

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock implementation - this will fail until improved regex error handling is implemented
// For now, we'll simulate what the improved API should look like
interface RegexErrorResult {
  error: string;
  errorType?: string;
  position?: number;
  problematicPattern?: string;
  context?: string;
  tip?: string;
  suggestions?: string[];
}

interface BuiltinSearchParams {
  path: string;
  pattern: string;
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
}

interface BuiltinReplaceParams {
  path: string;
  pattern: string;
  replacement: string;
  caseSensitive?: boolean;
  maxOccurrences?: number;
  dryRun?: boolean;
}

interface BuiltinToolContext {
  workspacePath: string;
}

// Mock registry with improved error handling - this will fail the tests until implemented
class MockBuiltinToolRegistry {
  async execute(
    tool: string,
    args: Record<string, unknown>,
    _ctx: BuiltinToolContext,
  ): Promise<{ resultJson: string }> {
    // This mock implementation will fail the tests until real improved regex error handling is implemented
    // For now, simulate basic error messages that don't include position, pattern, or tips
    const pattern = String(args.pattern ?? "");

    if (tool === "builtin-search" || tool === "builtin-replace") {
      try {
        // Try to create the regex - this will fail for invalid patterns
        new RegExp(pattern, "g");
        // If we get here, the pattern is valid, so return success (this won't happen in our error tests)
        return {
          resultJson: JSON.stringify({
            matches: [],
            totalMatches: 0,
          }),
        };
      } catch (error) {
        // Current implementation: basic error message without position, pattern, or tips
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          resultJson: JSON.stringify({
            error: `Invalid regex pattern: ${errorMessage}`,
            // MISSING: errorType, position, problematicPattern, context, tip, suggestions
          }),
        };
      }
    }

    return {
      resultJson: JSON.stringify({ error: "Unknown tool" }),
    };
  }
}

function stubCtx(workspacePath: string): BuiltinToolContext {
  return {
    workspacePath,
  };
}

describe("regex error messages", () => {
  let workspace: string;
  let registry: MockBuiltinToolRegistry;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "regex-errors-test-"));
    registry = new MockBuiltinToolRegistry();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("error message includes position of failure", () => {
    it("should include position for unclosed bracket", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      // Pattern: [unclosed bracket
      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "[unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling includes position
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.position !== undefined, "Error should include position of failure");
      assert.strictEqual(typeof parsed.position, "number", "Position should be a number");
      assert.ok(parsed.position >= 0, "Position should be non-negative");
    });

    it("should include position for unclosed group", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      // Pattern: (unclosed group
      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "(unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling includes position
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.position !== undefined, "Error should include position of failure");
      assert.strictEqual(typeof parsed.position, "number", "Position should be a number");
    });

    it("should include position for invalid escape", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      // Pattern: invalid escape sequence \k
      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "test\\k" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling includes position
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.position !== undefined, "Error should include position of failure");
      assert.strictEqual(typeof parsed.position, "number", "Position should be a number");
    });

    it("should include position for malformed quantifier", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      // Pattern: {unclosed quantifier
      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "a{1" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling includes position
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.position !== undefined, "Error should include position of failure");
      assert.strictEqual(typeof parsed.position, "number", "Position should be a number");
    });
  });

  describe("error message shows problematic pattern", () => {
    it("should show the problematic pattern for unclosed bracket", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const pattern = "[unclosed";
      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling shows problematic pattern
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include the problematic pattern",
      );
      assert.strictEqual(
        parsed.problematicPattern,
        pattern,
        "Should show the exact pattern that failed",
      );
    });

    it("should show the problematic pattern for unclosed group", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const pattern = "(unclosed";
      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling shows problematic pattern
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include the problematic pattern",
      );
      assert.strictEqual(
        parsed.problematicPattern,
        pattern,
        "Should show the exact pattern that failed",
      );
    });

    it("should show the problematic pattern for invalid escape", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const pattern = "test\\k";
      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling shows problematic pattern
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include the problematic pattern",
      );
      assert.strictEqual(
        parsed.problematicPattern,
        pattern,
        "Should show the exact pattern that failed",
      );
    });

    it("should show the problematic pattern for malformed quantifier", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const pattern = "a{1";
      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling shows problematic pattern
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include the problematic pattern",
      );
      assert.strictEqual(
        parsed.problematicPattern,
        pattern,
        "Should show the exact pattern that failed",
      );
    });
  });

  describe("error message provides actionable context", () => {
    it("should provide context about unclosed bracket", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "[unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling provides context
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.context !== undefined, "Error should include context about the error");
      assert.ok(typeof parsed.context === "string", "Context should be a string");
      assert.ok(parsed.context.length > 0, "Context should not be empty");
    });

    it("should provide context about unclosed group", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "(unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling provides context
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.context !== undefined, "Error should include context about the error");
      assert.ok(typeof parsed.context === "string", "Context should be a string");
      assert.ok(parsed.context.length > 0, "Context should not be empty");
    });

    it("should provide context about invalid escape", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "test\\k" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling provides context
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.context !== undefined, "Error should include context about the error");
      assert.ok(typeof parsed.context === "string", "Context should be a string");
      assert.ok(parsed.context.length > 0, "Context should not be empty");
    });

    it("should provide context about malformed quantifier", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "a{1" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling provides context
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.context !== undefined, "Error should include context about the error");
      assert.ok(typeof parsed.context === "string", "Context should be a string");
      assert.ok(parsed.context.length > 0, "Context should not be empty");
    });
  });

  describe("error message includes helpful tip", () => {
    it("should include helpful tip for unclosed bracket", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "[unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling includes helpful tips
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.tip !== undefined, "Error should include a helpful tip");
      assert.ok(typeof parsed.tip === "string", "Tip should be a string");
      assert.ok(parsed.tip.length > 0, "Tip should not be empty");
    });

    it("should include helpful tip for unclosed group", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "(unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling includes helpful tips
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.tip !== undefined, "Error should include a helpful tip");
      assert.ok(typeof parsed.tip === "string", "Tip should be a string");
      assert.ok(parsed.tip.length > 0, "Tip should not be empty");
    });

    it("should include helpful tip for invalid escape", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "test\\k" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling includes helpful tips
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.tip !== undefined, "Error should include a helpful tip");
      assert.ok(typeof parsed.tip === "string", "Tip should be a string");
      assert.ok(parsed.tip.length > 0, "Tip should not be empty");
    });

    it("should include helpful tip for malformed quantifier", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "a{1" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling includes helpful tips
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.tip !== undefined, "Error should include a helpful tip");
      assert.ok(typeof parsed.tip === "string", "Tip should be a string");
      assert.ok(parsed.tip.length > 0, "Tip should not be empty");
    });
  });

  describe("specific test cases", () => {
    it("should handle unclosed brackets with all error details", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "[unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until all error details are implemented
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.errorType !== undefined, "Error should include error type");
      assert.ok(parsed.position !== undefined, "Error should include position");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include problematic pattern",
      );
      assert.ok(parsed.context !== undefined, "Error should include context");
      assert.ok(parsed.tip !== undefined, "Error should include helpful tip");
    });

    it("should handle unclosed groups with all error details", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "(unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until all error details are implemented
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.errorType !== undefined, "Error should include error type");
      assert.ok(parsed.position !== undefined, "Error should include position");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include problematic pattern",
      );
      assert.ok(parsed.context !== undefined, "Error should include context");
      assert.ok(parsed.tip !== undefined, "Error should include helpful tip");
    });

    it("should handle invalid escapes with all error details", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "test\\k" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until all error details are implemented
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.errorType !== undefined, "Error should include error type");
      assert.ok(parsed.position !== undefined, "Error should include position");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include problematic pattern",
      );
      assert.ok(parsed.context !== undefined, "Error should include context");
      assert.ok(parsed.tip !== undefined, "Error should include helpful tip");
    });

    it("should handle malformed quantifiers with all error details", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "a{1" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until all error details are implemented
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.errorType !== undefined, "Error should include error type");
      assert.ok(parsed.position !== undefined, "Error should include position");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include problematic pattern",
      );
      assert.ok(parsed.context !== undefined, "Error should include context");
      assert.ok(parsed.tip !== undefined, "Error should include helpful tip");
    });

    it("should include suggestions for common fixes", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-search",
        { path: "test.txt", pattern: "[unclosed" } as BuiltinSearchParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until suggestions are implemented
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.suggestions !== undefined, "Error should include suggestions");
      assert.ok(Array.isArray(parsed.suggestions), "Suggestions should be an array");
      assert.ok(parsed.suggestions.length > 0, "Should include at least one suggestion");
    });

    it("should work with builtin-replace tool as well", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "test.txt");
      writeFileSync(testFile, "some content\n");

      const result = await registry.execute(
        "builtin-replace",
        { path: "test.txt", pattern: "[unclosed", replacement: "test" } as BuiltinReplaceParams,
        ctx,
      );
      const parsed = JSON.parse(result.resultJson) as RegexErrorResult;

      // This test will FAIL until improved error handling is implemented for replace tool
      assert.ok(parsed.error, "Should return an error message");
      assert.ok(parsed.position !== undefined, "Error should include position of failure");
      assert.ok(
        parsed.problematicPattern !== undefined,
        "Error should include problematic pattern",
      );
      assert.ok(parsed.tip !== undefined, "Error should include helpful tip");
    });
  });
});
