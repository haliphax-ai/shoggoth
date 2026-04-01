import assert from "node:assert";
import { describe, it } from "node:test";
import { resolveEffectiveSessionQueryAllowedAgentIds } from "../src/effective-agent-for-session.js";
import type { ShoggothConfig } from "../src/schema.js";

describe("resolveEffectiveSessionQueryAllowedAgentIds", () => {
  const base: ShoggothConfig = {
    logLevel: "info",
    stateDbPath: "/tmp/s.db",
    socketPath: "/tmp/s.sock",
    workspacesRoot: "/w",
    secretsDirectory: "/s",
    inboundMediaRoot: "/m",
    operatorDirectory: "/o",
    configDirectory: "/c",
    hitl: {
      defaultApprovalTimeoutMs: 1,
      toolRisk: {},
      agentBypassUpTo: {},
      agentToolAutoApprove: {},
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    policy: {
      operator: { controlOps: { allow: ["*"], deny: [] }, tools: { allow: ["*"], deny: [] } },
      agent: { controlOps: { allow: ["*"], deny: [] }, tools: { allow: ["*"], deny: [] } },
      auditRedaction: { jsonPaths: [] },
    },
  };

  it("defaults to own agent id only", () => {
    const allowed = resolveEffectiveSessionQueryAllowedAgentIds(base, "alice");
    assert.deepStrictEqual([...allowed], ["alice"]);
  });

  it("merges global allowedAgentIds", () => {
    const cfg: ShoggothConfig = {
      ...base,
      sessionQuery: { allowedAgentIds: ["bob"] },
    };
    const allowed = resolveEffectiveSessionQueryAllowedAgentIds(cfg, "alice");
    assert.ok(allowed.has("alice"));
    assert.ok(allowed.has("bob"));
  });

  it("merges per-agent allowedAgentIds", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: {
          alice: { sessionQuery: { allowedAgentIds: ["charlie"] } },
        },
      },
    };
    const allowed = resolveEffectiveSessionQueryAllowedAgentIds(cfg, "alice");
    assert.ok(allowed.has("alice"));
    assert.ok(allowed.has("charlie"));
  });

  it("merges global + per-agent and deduplicates", () => {
    const cfg: ShoggothConfig = {
      ...base,
      sessionQuery: { allowedAgentIds: ["bob", "charlie"] },
      agents: {
        list: {
          alice: { sessionQuery: { allowedAgentIds: ["charlie", "dave"] } },
        },
      },
    };
    const allowed = resolveEffectiveSessionQueryAllowedAgentIds(cfg, "alice");
    assert.deepStrictEqual([...allowed].sort(), ["alice", "bob", "charlie", "dave"]);
  });

  it("always includes own agent id even when not in any list", () => {
    const cfg: ShoggothConfig = {
      ...base,
      sessionQuery: { allowedAgentIds: ["bob"] },
    };
    const allowed = resolveEffectiveSessionQueryAllowedAgentIds(cfg, "alice");
    assert.ok(allowed.has("alice"));
  });
});
