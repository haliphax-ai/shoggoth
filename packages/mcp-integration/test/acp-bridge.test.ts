import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createAcpxBinding, findBindingForAcpxWorkspace } from "../src/acp-bridge";

describe("acp-bridge", () => {
  it("finds binding by workspace root", () => {
    const b = createAcpxBinding({
      acpWorkspaceRoot: "/tmp/acp/w1",
      shoggothSessionId: "sess-1",
      agentPrincipalId: "agent-1",
    });
    const hit = findBindingForAcpxWorkspace([b], "/tmp/acp/w1");
    assert.equal(hit?.shoggothSessionId, "sess-1");
  });
});
