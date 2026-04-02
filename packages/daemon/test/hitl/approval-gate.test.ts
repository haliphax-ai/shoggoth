import { describe, it } from "vitest";
import assert from "node:assert";
import { requiresHumanApproval } from "../../src/hitl/approval-gate";

describe("requiresHumanApproval", () => {
  it("requires approval for caution and critical when bypass is safe", () => {
    assert.equal(requiresHumanApproval("safe", "safe"), false);
    assert.equal(requiresHumanApproval("caution", "safe"), true);
    assert.equal(requiresHumanApproval("critical", "safe"), true);
  });

  it("allows all tiers when bypass is critical", () => {
    assert.equal(requiresHumanApproval("safe", "critical"), false);
    assert.equal(requiresHumanApproval("caution", "critical"), false);
    assert.equal(requiresHumanApproval("critical", "critical"), false);
  });

  it("allows safe and caution when bypass is caution", () => {
    assert.equal(requiresHumanApproval("caution", "caution"), false);
    assert.equal(requiresHumanApproval("critical", "caution"), true);
  });

  it("requires approval for never tier unless bypass is never", () => {
    assert.equal(requiresHumanApproval("never", "safe"), true);
    assert.equal(requiresHumanApproval("never", "caution"), true);
    assert.equal(requiresHumanApproval("never", "critical"), true);
    assert.equal(requiresHumanApproval("never", "never"), false);
  });
});
