import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { assertValidSubagentAgentId, deriveThreadSubagentAgentId } from "../src/agent-id";

describe("subagent agent IDs", () => {
  it("accepts only 1-20 alphanumerics or dashes", () => {
    for (const id of ["a", "Agent-2", "a".repeat(20)]) assertValidSubagentAgentId(id);
    for (const id of ["", " ", "under_score", "dot.name", "has space", "x".repeat(21)]) {
      assert.throws(() => assertValidSubagentAgentId(id));
    }
  });

  it("derives a sanitized and bounded thread-title slug", () => {
    assert.equal(
      deriveThreadSubagentAgentId("  Fix: API docs!  ", () => false),
      "Fix-API-docs",
    );
    assert.equal(
      deriveThreadSubagentAgentId("x".repeat(30), () => false),
      "x".repeat(20),
    );
    assert.equal(
      deriveThreadSubagentAgentId("!!!", () => false),
      "thread",
    );
  });

  it("adds collision counters while preserving the maximum length", () => {
    const taken = new Set(["Review", "Review-2"]);
    assert.equal(
      deriveThreadSubagentAgentId("Review", (id) => taken.has(id)),
      "Review-3",
    );
    const longBase = "x".repeat(20);
    assert.equal(
      deriveThreadSubagentAgentId(longBase, (id) => id === longBase),
      `${"x".repeat(18)}-2`,
    );
  });
});
