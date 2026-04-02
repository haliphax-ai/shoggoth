import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { hitlAutoApproveToolNamesMatch } from "../../src/hitl/hitl-tool-name-match.js";

describe("hitlAutoApproveToolNamesMatch", () => {
  it("matches only exact canonical names", () => {
    assert.equal(hitlAutoApproveToolNamesMatch("builtin-exec", "builtin-exec"), true);
    assert.equal(hitlAutoApproveToolNamesMatch("builtin-exec", "exec"), false);
    assert.equal(hitlAutoApproveToolNamesMatch("exec", "builtin-exec"), false);
    assert.equal(hitlAutoApproveToolNamesMatch("canvas-web-foo", "canvas-web-foo"), true);
    assert.equal(hitlAutoApproveToolNamesMatch("canvas-web-foo", "foo"), false);
    assert.equal(hitlAutoApproveToolNamesMatch("foo", "canvas-web-foo"), false);
    assert.equal(hitlAutoApproveToolNamesMatch("builtin-exec", "builtin-write"), false);
    assert.equal(hitlAutoApproveToolNamesMatch("", "builtin-exec"), false);
    assert.equal(hitlAutoApproveToolNamesMatch("builtin-exec", ""), false);
  });
});
