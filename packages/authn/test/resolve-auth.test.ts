import assert from "node:assert";
import { describe, it } from "vitest";
import { MemoryAgentTokenStore, mintAgentCredentialRaw } from "../src/agent-token";
import { operatorMapFromFileJson } from "../src/operator-map";
import { resolveAuthenticatedPrincipal } from "../src/resolve-auth";

const peer = { uid: 1000, gid: 1000, pid: 1 };

describe("resolveAuthenticatedPrincipal", () => {
  it("resolves operator_peercred", () => {
    const map = operatorMapFromFileJson({
      byUid: { "1000": { operatorId: "op", roles: ["a"] } },
    });
    const p = resolveAuthenticatedPrincipal(
      { kind: "operator_peercred" },
      {
        peer,
        operatorMap: map,
        agentTokenStore: new MemoryAgentTokenStore(),
      },
    );
    assert(p && p.kind === "operator");
    assert.strictEqual(p.operatorId, "op");
  });

  it("resolves operator_token when secret matches", () => {
    const map = operatorMapFromFileJson({
      byUid: { "1000": { operatorId: "op", roles: [] } },
    });
    const p = resolveAuthenticatedPrincipal(
      { kind: "operator_token", token: "sekrit" },
      {
        peer,
        operatorMap: map,
        operatorTokenSecret: "sekrit",
        agentTokenStore: new MemoryAgentTokenStore(),
      },
    );
    assert(p && p.kind === "operator");
    assert.strictEqual(p.source, "cli_operator_token");
  });

  it("denies operator_token without configured secret", () => {
    const map = operatorMapFromFileJson({
      byUid: { "1000": { operatorId: "op", roles: [] } },
    });
    const p = resolveAuthenticatedPrincipal(
      { kind: "operator_token", token: "x" },
      {
        peer,
        operatorMap: map,
        agentTokenStore: new MemoryAgentTokenStore(),
      },
    );
    assert.strictEqual(p, null);
  });

  it("resolves agent when store validates", () => {
    const store = new MemoryAgentTokenStore();
    const raw = mintAgentCredentialRaw();
    store.register("sess-a", raw);
    const map = operatorMapFromFileJson({ byUid: {} });
    const p = resolveAuthenticatedPrincipal(
      { kind: "agent", session_id: "sess-a", token: raw },
      {
        peer,
        operatorMap: map,
        agentTokenStore: store,
      },
    );
    assert(p && p.kind === "agent");
    assert.strictEqual(p.sessionId, "sess-a");
  });
});
