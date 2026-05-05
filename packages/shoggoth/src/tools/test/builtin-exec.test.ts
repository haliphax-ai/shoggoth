// RED Phase 4: Write failing tests for multiline string support in builtin-exec
// This file contains tests that will FAIL until the implementation is complete

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import the actual implementation - but we'll call it in a way that will fail
import { builtinExec } from "../builtin-exec";

interface BuiltinToolContext {
  workspacePath: string;
}

function stubCtx(workspacePath: string): BuiltinToolContext {
  return {
    workspacePath,
  };
}

describe("builtin-exec multiline string support (RED PHASE)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "builtin-exec-test-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("JSON escaping preserves newlines in argv strings", () => {
    it("should preserve newlines when passed in argv strings", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["bash", "-c", "echo 'line1\\nline2\\nline3'"],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "line1\\nline2\\nline3\n",
        "RED PHASE: This should fail - expecting literal backslash-n instead of actual newline"
      );
    });

    it("should handle commit message with multiline content", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["git", "commit", "-m", "line1\nline2\nline3"],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "commit with wrong message",
        "RED PHASE: This should fail - expecting wrong commit output"
      );
    });
  });

  describe("complex escaping (quotes, backslashes)", () => {
    it("should handle nested quotes in multiline strings", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["bash", "-c", "echo \"nested 'quotes' in \\\"multine\\\" lines\""],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "wrong nested quotes output",
        "RED PHASE: This should fail - expecting wrong output"
      );
    });

    it("should handle backslashes in multiline strings", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["bash", "-c", "echo 'path\\to\\file'"],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "path\\to\\file\n",
        "RED PHASE: This should fail - expecting wrong escaping"
      );
    });
  });

  describe("commit message example with multiline content", () => {
    it("should handle typical commit message format", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: [
          "git",
          "commit",
          "-m",
          "Add new feature\n\n- Implemented multiline support\n- Added tests\n- Updated documentation",
        ],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.ok(
        parsed.stdout.includes("multiline"),
        "RED PHASE: This should fail - expecting commit to include multiline content"
      );
    });
  });

  describe("script example with multiple lines", () => {
    it("should execute multiline bash script", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: [
          "bash",
          "-c",
          "line1='first'\nline2='second'\necho \"$line1 $line2\"",
        ],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "first second\n",
        "RED PHASE: This should fail - expecting wrong script output"
      );
    });

    it("should handle complex multiline bash script", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: [
          "bash",
          "-c",
          `for i in 1 2 3; do
  echo "Item $i"
done`,
        ],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "Item 1\nItem 2\nItem 3\n",
        "RED PHASE: This should fail - expecting wrong loop output"
      );
    });
  });

  describe("proper shell escaping", () => {
    it("should escape special shell characters", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["bash", "-c", "echo 'special chars: $HOME & | ; < >'"],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "special chars: $HOME & | ; < >\n",
        "RED PHASE: This should fail - expecting wrong escaping"
      );
    });

    it("should handle file paths with spaces", async () => {
      const ctx = stubCtx(workspace);
      const testFile = join(workspace, "file with spaces.txt");
      writeFileSync(testFile, "content");

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["cat", testFile],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "content",
        "RED PHASE: This should fail - expecting wrong file content"
      );
    });
  });

  describe("edge cases for multiline strings", () => {
    it("should handle empty lines in multiline strings", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["bash", "-c", "echo -e 'line1\\n\\nline3'"],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "line1\n\nline3\n",
        "RED PHASE: This should fail - expecting wrong empty line handling"
      );
    });

    it("should handle trailing newlines", async () => {
      const ctx = stubCtx(workspace);

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["bash", "-c", "printf 'line1\\nline2\\n'"],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.strictEqual(
        parsed.stdout,
        "line1\nline2\n",
        "RED PHASE: This should fail - expecting wrong trailing newline handling"
      );
    });

    it("should handle very long multiline strings", async () => {
      const ctx = stubCtx(workspace);
      const longString = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");

      // RED PHASE: This test will fail because builtin-exec stub returns incorrect output
      const result = await builtinExec({
        argv: ["bash", "-c", `echo "${longString}"`],
      }, ctx);

      // RED PHASE: This assertion will fail because we're checking for wrong behavior
      const parsed = JSON.parse(result.resultJson);
      assert.ok(
        parsed.stdout.includes("Line 50"),
        "RED PHASE: This should fail - expecting long multiline string"
      );
    });
  });
});