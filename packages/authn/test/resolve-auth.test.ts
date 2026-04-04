import assert from "node:assert";
import { describe, it } from "vitest";
import { MemoryAgentTokenStore, mintAgentCredentialRaw } from "../src/agent-token";
import { resolveAuthenticatedPrincipal } from "../src/resolve-auth";

describe("resolveAuthenticatedPrincipal", () => {
  it("resolves operator_token when secret matches", () => {
    const p = resolveAuthenticatedPrincipal(
      { kind: "operator_token", token: "sekrit" },
      {
        operatorTokenSecret: "sekrit",
        agentTokenStore: new MemoryAgentTokenStore(),
      },
    );
    assert(p && p.kind === "operator");
    assert.strictEqual(p.source, "cli_operator_token");
  });

  it("denies operator_token without configured secret", () => {
    const p = resolveAuthenticatedPrincipal(
      { kind: "operator_token", token: "x" },
      {
        agentTokenStore: new MemoryAgentTokenStore(),
      },
    );
    assert.strictEqual(p, null);
  });

  it("resolves agent when store validates", () => {
    const store = new MemoryAgentTokenStore();
    const raw = mintAgentCredentialRaw();
    store.register("sess-a", raw);
    const p = resolveAuthenticatedPrincipal(
      { kind: "agent", session_id: "sess-a", token: raw },
      {
        agentTokenStore: store,
      },
    );
    assert(p && p.kind === "agent");
    assert.strictEqual(p.sessionId, "sess-a");
  });
});
