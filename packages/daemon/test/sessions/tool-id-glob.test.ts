import { describe, it } from "vitest";
import assert from "node:assert";
import { isGlobPattern, toolIdGlobMatches, matchToolIds } from "../../src/sessions/tool-id-glob";

describe("tool-id-glob", () => {
  describe("isGlobPattern", () => {
    it("detects * and ?", () => {
      assert.equal(isGlobPattern("kanban-*"), true);
      assert.equal(isGlobPattern("lsp-?"), true);
      assert.equal(isGlobPattern("builtin-read"), false);
    });
  });

  describe("toolIdGlobMatches", () => {
    it("exact match without wildcards", () => {
      assert.equal(toolIdGlobMatches("builtin-read", "builtin-read"), true);
      assert.equal(toolIdGlobMatches("builtin-read", "builtin-replace"), false);
      // Partial IDs must not match a wildcard-free pattern
      assert.equal(toolIdGlobMatches("builtin", "builtin-read"), false);
    });

    it("prefix glob * matches any suffix including separators", () => {
      assert.equal(toolIdGlobMatches("kanban-*", "kanban-add-card"), true);
      assert.equal(toolIdGlobMatches("kanban-*", "kanban"), false);
      assert.equal(toolIdGlobMatches("kanban-*", "builtin-kanban-add"), false);
      assert.equal(toolIdGlobMatches("*", "any-tool"), true);
    });

    it("mid and suffix wildcards", () => {
      assert.equal(toolIdGlobMatches("lsp-*_content", "lsp-replace_content"), true);
      assert.equal(toolIdGlobMatches("*exec", "builtin-exec"), true);
      assert.equal(toolIdGlobMatches("*exec", "builtin-exec-extended"), false);
    });

    it("? matches exactly one character", () => {
      assert.equal(toolIdGlobMatches("builtin-rea?", "builtin-read"), true);
      assert.equal(toolIdGlobMatches("builtin-rea?", "builtin-rea"), false);
      assert.equal(toolIdGlobMatches("builtin-rea?", "builtin-readd"), false);
    });

    it("anchors the whole ID (no partial matches)", () => {
      assert.equal(toolIdGlobMatches("kanban*", "xkanban-add"), false);
    });

    it("escapes regex metacharacters in the pattern", () => {
      // '.' is a literal — must not act as a wildcard
      assert.equal(toolIdGlobMatches("a.c", "abc"), false);
      assert.equal(toolIdGlobMatches("a.c", "a.c"), true);
      // Pattern-only regex chars must not throw
      assert.equal(toolIdGlobMatches("foo+bar*", "foo+bar-baz"), true);
      assert.equal(toolIdGlobMatches("(x)*", "(x)-1"), true);
    });
  });

  describe("matchToolIds", () => {
    it("collects only matching IDs, in input order", () => {
      const ids = ["builtin-read", "kanban-add", "kanban-list", "lsp-find_symbol"];
      assert.deepEqual(matchToolIds("kanban-*", ids), ["kanban-add", "kanban-list"]);
      assert.deepEqual(matchToolIds("builtin-read", ids), ["builtin-read"]);
      assert.deepEqual(matchToolIds("nope-*", ids), []);
    });
  });
});
