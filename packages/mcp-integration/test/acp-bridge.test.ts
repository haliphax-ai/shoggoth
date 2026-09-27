import assert from "node:assert/strict";
import { describe, it } from "vitest";
import * as acpBridge from "../src/acp-bridge";
import * as packageIndex from "../src/index";
import { findBindingForAcpxWorkspace, type AcpxWorkspaceBinding } from "../src/acp-bridge";

describe("acp-bridge", () => {
  it("no longer exports a createAcpxBinding factory", () => {
    assert.equal("createAcpxBinding" in acpBridge, false);
    assert.equal("createAcpxBinding" in packageIndex, false);
  });

  it("finds a directly constructed binding by workspace root", () => {
    const binding: AcpxWorkspaceBinding = {
      acpWorkspaceRoot: "/tmp/acp/w1",
      shoggothSessionId: "sess-1",
      agentPrincipalId: "agent-1",
    };
    const hit = findBindingForAcpxWorkspace([binding], "/tmp/acp/w1");
    assert.equal(hit?.shoggothSessionId, "sess-1");
    assert.equal(hit?.agentPrincipalId, "agent-1");
  });

  it("returns undefined for a different workspace root", () => {
    const binding: AcpxWorkspaceBinding = {
      acpWorkspaceRoot: "/tmp/acp/w1",
      shoggothSessionId: "sess-1",
      agentPrincipalId: "agent-1",
    };
    assert.equal(findBindingForAcpxWorkspace([binding], "/tmp/acp/other"), undefined);
  });
});
