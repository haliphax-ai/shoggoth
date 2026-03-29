import { describe, it } from "node:test";
import assert from "node:assert";
import { effectiveBypassUpTo, requiresHumanApproval } from "../../src/hitl/approval-gate";
import type { HitlRiskTier } from "@shoggoth/shared";

describe("effectiveBypassUpTo", () => {
  it("defaults to safe when no roles match", () => {
    assert.equal(effectiveBypassUpTo(["agent"], { admin: "critical" }), "safe");
  });

  it("picks the most permissive bypass among matched roles", () => {
    const roleBypass: Record<string, HitlRiskTier> = {
      viewer: "safe",
      power_user: "caution",
      admin: "critical",
    };
    assert.equal(effectiveBypassUpTo(["viewer", "admin"], roleBypass), "critical");
    assert.equal(effectiveBypassUpTo(["viewer", "power_user"], roleBypass), "caution");
  });
});

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
});
