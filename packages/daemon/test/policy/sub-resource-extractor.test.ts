import assert from "node:assert";
import { describe, it } from "node:test";
import { execSubResourceExtractor } from "../../src/policy/sub-resource";

describe("execSubResourceExtractor", () => {
  it("extracts command name from simple command", () => {
    assert.strictEqual(
      execSubResourceExtractor({ command: "curl https://example.com" }),
      "curl",
    );
  });

  it("extracts basename from absolute path", () => {
    assert.strictEqual(
      execSubResourceExtractor({ command: "/usr/bin/curl https://example.com" }),
      "curl",
    );
  });

  it("extracts command name with flags", () => {
    assert.strictEqual(
      execSubResourceExtractor({ command: "bash -c 'echo hello'" }),
      "bash",
    );
  });

  it("returns 'unknown' for empty command", () => {
    assert.strictEqual(
      execSubResourceExtractor({ command: "" }),
      "unknown",
    );
  });

  it("handles leading/trailing whitespace", () => {
    assert.strictEqual(
      execSubResourceExtractor({ command: "  git status  " }),
      "git",
    );
  });

  it("returns 'unknown' for undefined command", () => {
    assert.strictEqual(
      execSubResourceExtractor({}),
      "unknown",
    );
  });

  it("handles command with only whitespace", () => {
    assert.strictEqual(
      execSubResourceExtractor({ command: "   " }),
      "unknown",
    );
  });

  it("extracts basename from relative path", () => {
    assert.strictEqual(
      execSubResourceExtractor({ command: "./scripts/deploy.sh --prod" }),
      "deploy.sh",
    );
  });
});
