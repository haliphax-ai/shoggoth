import assert from "node:assert";
import { describe, it } from "vitest";
import {
  crossAgentSessionSendAllowed,
  mergeAgentToAgentAllowPatterns,
} from "../src/agent-to-agent-policy.js";

describe("agent-to-agent policy", () => {
  it("allows same agent without config", () => {
    assert.equal(crossAgentSessionSendAllowed({}, "main", "main"), true);
  });

  it("denies cross-agent when allow data is absent", () => {
    assert.equal(crossAgentSessionSendAllowed({}, "alice", "bob"), false);
  });

  it("denies cross-agent when merged allow is empty", () => {
    assert.equal(crossAgentSessionSendAllowed({ agentToAgent: { allow: [] } }, "alice", "bob"), false);
  });

  it("allows any cross-agent target when * is present", () => {
    assert.equal(crossAgentSessionSendAllowed({ agentToAgent: { allow: ["*"] } }, "a", "b"), true);
  });

  it("allows only listed targets from global allow", () => {
    const cfg = { agentToAgent: { allow: ["bob", "carol"] } };
    assert.equal(crossAgentSessionSendAllowed(cfg, "alice", "bob"), true);
    assert.equal(crossAgentSessionSendAllowed(cfg, "alice", "dave"), false);
  });

  it("merges global allow with agents.list entry for sender", () => {
    const cfg = {
      agentToAgent: { allow: ["bob"] },
      agents: {
        list: { alice: { agentToAgent: { allow: ["carol"] } } },
      },
    };
    assert.equal(crossAgentSessionSendAllowed(cfg, "alice", "bob"), true);
    assert.equal(crossAgentSessionSendAllowed(cfg, "alice", "carol"), true);
    assert.equal(crossAgentSessionSendAllowed(cfg, "alice", "dave"), false);
    assert.equal(crossAgentSessionSendAllowed(cfg, "eve", "carol"), false);
    assert.equal(crossAgentSessionSendAllowed(cfg, "eve", "bob"), true);
  });

  it("dedupes mergeAgentToAgentAllowPatterns", () => {
    const cfg = {
      agentToAgent: { allow: ["bob", "bob"] },
      agents: { list: { a: { agentToAgent: { allow: ["bob"] } } } },
    };
    assert.deepStrictEqual(mergeAgentToAgentAllowPatterns(cfg, "a"), ["bob"]);
  });
});
