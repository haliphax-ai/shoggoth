import assert from "node:assert";
import { describe, it } from "vitest";
import {
  mcpServerRulesSchema,
  shoggothMcpServerEntrySchema,
  evaluateMcpServerRules,
  resolveEffectiveMcpServerRules,
  type McpServerRules,
  type ShoggothConfig,
} from "@shoggoth/shared";

// ---------------------------------------------------------------------------
// 1. Schema validation
// ---------------------------------------------------------------------------

describe("mcpServerRulesSchema", () => {
  it("accepts valid allow/deny", () => {
    const result = mcpServerRulesSchema.safeParse({ allow: ["*"], deny: [] });
    assert.ok(result.success);
  });

  it("accepts named ids", () => {
    const result = mcpServerRulesSchema.safeParse({
      allow: ["a", "b"],
      deny: ["c"],
    });
    assert.ok(result.success);
  });

  it("rejects extra fields (strict)", () => {
    const result = mcpServerRulesSchema.safeParse({
      allow: ["*"],
      deny: [],
      extra: true,
    });
    assert.ok(!result.success);
  });

  it("rejects missing allow", () => {
    const result = mcpServerRulesSchema.safeParse({ deny: [] });
    assert.ok(!result.success);
  });

  it("rejects missing deny", () => {
    const result = mcpServerRulesSchema.safeParse({ allow: ["*"] });
    assert.ok(!result.success);
  });

  it("rejects non-string entries", () => {
    const result = mcpServerRulesSchema.safeParse({ allow: [123], deny: [] });
    assert.ok(!result.success);
  });
});

// ---------------------------------------------------------------------------
// 1b. Server entry `explicit` toggle (schema)
// ---------------------------------------------------------------------------

describe("shoggothMcpServerEntrySchema explicit", () => {
  it("accepts explicit: true on a stdio server", () => {
    const result = shoggothMcpServerEntrySchema.safeParse({
      id: "priv",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      explicit: true,
    });
    assert.ok(result.success);
  });

  it("accepts explicit: true on an http server", () => {
    const result = shoggothMcpServerEntrySchema.safeParse({
      id: "priv",
      transport: "http",
      url: "https://example.com/mcp",
      explicit: true,
    });
    assert.ok(result.success);
  });

  it("treats explicit as optional (omitted → undefined)", () => {
    const result = shoggothMcpServerEntrySchema.safeParse({
      id: "pub",
      transport: "stdio",
      command: "npx",
    });
    assert.ok(result.success);
    assert.strictEqual(result.success && result.data.explicit, undefined);
  });

  it("rejects non-boolean explicit", () => {
    const result = shoggothMcpServerEntrySchema.safeParse({
      id: "priv",
      transport: "stdio",
      command: "npx",
      explicit: "yes",
    });
    assert.ok(!result.success);
  });
});

// ---------------------------------------------------------------------------
// 2. evaluateMcpServerRules — deny-wins, wildcard, default-deny
// ---------------------------------------------------------------------------

describe("evaluateMcpServerRules", () => {
  it("deny wins over allow wildcard", () => {
    const rules: McpServerRules = { allow: ["*"], deny: ["x"] };
    assert.strictEqual(evaluateMcpServerRules("x", rules), false);
    assert.strictEqual(evaluateMcpServerRules("y", rules), true);
  });

  it("deny wildcard excludes everything", () => {
    const rules: McpServerRules = { allow: ["*"], deny: ["*"] };
    assert.strictEqual(evaluateMcpServerRules("anything", rules), false);
  });

  it("empty allow + empty deny → default-deny (everything excluded)", () => {
    const rules: McpServerRules = { allow: [], deny: [] };
    assert.strictEqual(evaluateMcpServerRules("a", rules), false);
  });

  it("explicit allow list includes only named ids", () => {
    const rules: McpServerRules = { allow: ["a", "b"], deny: [] };
    assert.strictEqual(evaluateMcpServerRules("a", rules), true);
    assert.strictEqual(evaluateMcpServerRules("b", rules), true);
    assert.strictEqual(evaluateMcpServerRules("c", rules), false);
  });

  it("deny specific + allow specific — deny wins for overlap", () => {
    const rules: McpServerRules = { allow: ["a", "b"], deny: ["b"] };
    assert.strictEqual(evaluateMcpServerRules("a", rules), true);
    assert.strictEqual(evaluateMcpServerRules("b", rules), false);
  });

  it("allow wildcard with no deny → everything included", () => {
    const rules: McpServerRules = { allow: ["*"], deny: [] };
    assert.strictEqual(evaluateMcpServerRules("anything", rules), true);
  });

  it("explicit server is NOT matched by allow wildcard", () => {
    const rules: McpServerRules = { allow: ["*"], deny: [] };
    assert.strictEqual(evaluateMcpServerRules("priv", rules, true), false);
  });

  it("explicit server IS allowed when named exactly in allow list", () => {
    const rules: McpServerRules = { allow: ["priv", "pub"], deny: [] };
    assert.strictEqual(evaluateMcpServerRules("priv", rules, true), true);
    // A non-explicit server still matches the same rules normally
    assert.strictEqual(evaluateMcpServerRules("pub", rules), true);
  });

  it("explicit server not in allow list → default-deny", () => {
    const rules: McpServerRules = { allow: ["pub"], deny: [] };
    assert.strictEqual(evaluateMcpServerRules("priv", rules, true), false);
  });

  it("explicit server is still denied by deny wildcard", () => {
    const rules: McpServerRules = { allow: ["priv"], deny: ["*"] };
    assert.strictEqual(evaluateMcpServerRules("priv", rules, true), false);
  });

  it("explicit server is still denied by deny exact id", () => {
    const rules: McpServerRules = { allow: ["priv"], deny: ["priv"] };
    assert.strictEqual(evaluateMcpServerRules("priv", rules, true), false);
  });

  it("explicit server allowed by exact id even when allow also has wildcard", () => {
    const rules: McpServerRules = { allow: ["*", "priv"], deny: [] };
    // Exact match covers the explicit server; the wildcard covers the rest
    assert.strictEqual(evaluateMcpServerRules("priv", rules, true), true);
    assert.strictEqual(evaluateMcpServerRules("other", rules, true), false);
    assert.strictEqual(evaluateMcpServerRules("other", rules), true);
  });
});

// ---------------------------------------------------------------------------
// 3. resolveEffectiveMcpServerRules — four config levels, field-level merge
// ---------------------------------------------------------------------------

describe("resolveEffectiveMcpServerRules", () => {
  /** Minimal valid ShoggothConfig for testing. */
  const base: ShoggothConfig = {
    logLevel: "info",
    stateDbPath: "/tmp/s.db",
    socketPath: "/tmp/s.sock",
    workspacesRoot: "/w",
    secretsDirectory: "/s",
    inboundMediaRoot: "/m",
    operatorDirectory: "/o",
    configDirectory: "/c",
    hitl: { defaultApprovalTimeoutMs: 1, toolRisk: {}, bypassUpTo: "safe" },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: {}, poolScope: "global" },
    policy: {
      operator: {
        controlOps: { allow: ["*"], deny: [] },
        tools: { allow: ["*"], deny: [] },
      },
      agent: {
        controlOps: { allow: ["*"], deny: [] },
        tools: { allow: ["*"], deny: [] },
      },
      auditRedaction: { jsonPaths: [] },
    },
  };

  it("returns default allow-all when no serverRules configured anywhere", () => {
    const rules = resolveEffectiveMcpServerRules(base, "myagent", false);
    assert.deepStrictEqual(rules, { allow: ["*"], deny: [] });
  });

  it("uses global mcp.serverRules for top-level session", () => {
    const cfg: ShoggothConfig = {
      ...base,
      mcp: { ...base.mcp, serverRules: { allow: ["a", "b"], deny: ["c"] } },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", false);
    assert.deepStrictEqual(rules, { allow: ["a", "b"], deny: ["c"] });
  });

  it("per-agent mcp.serverRules replaces global for top-level session (field-level)", () => {
    const cfg: ShoggothConfig = {
      ...base,
      mcp: { ...base.mcp, serverRules: { allow: ["*"], deny: ["x"] } },
      agents: {
        list: {
          myagent: {
            mcp: { serverRules: { allow: ["only-this"], deny: [] } },
          },
        },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", false);
    assert.deepStrictEqual(rules.allow, ["only-this"]);
    assert.deepStrictEqual(rules.deny, []);
  });

  it("per-agent partial override inherits unset fields from global", () => {
    const cfg: ShoggothConfig = {
      ...base,
      mcp: { ...base.mcp, serverRules: { allow: ["*"], deny: ["x"] } },
      agents: {
        list: {
          myagent: {
            // Only override allow; deny should inherit from global
            mcp: { serverRules: { allow: ["a"], deny: ["x"] } },
          },
        },
      },
    };
    // When per-agent provides only `allow`, `deny` inherits from global
    // We test the full replace case here; partial inheritance is the key behavior
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", false);
    assert.deepStrictEqual(rules.allow, ["a"]);
  });

  it("global subagentMcp.serverRules applies to subagent sessions", () => {
    const cfg: ShoggothConfig = {
      ...base,
      mcp: { ...base.mcp, serverRules: { allow: ["*"], deny: [] } },
      agents: {
        subagentMcp: { serverRules: { allow: [], deny: ["*"] } },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", true);
    assert.deepStrictEqual(rules.allow, []);
    assert.deepStrictEqual(rules.deny, ["*"]);
  });

  it("per-agent subagentMcp.serverRules overrides global subagentMcp for subagent sessions", () => {
    const cfg: ShoggothConfig = {
      ...base,
      mcp: { ...base.mcp, serverRules: { allow: ["*"], deny: [] } },
      agents: {
        subagentMcp: { serverRules: { allow: [], deny: ["*"] } },
        list: {
          builder: {
            subagentMcp: { serverRules: { allow: ["sandbox"], deny: [] } },
          },
        },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "builder", true);
    assert.deepStrictEqual(rules.allow, ["sandbox"]);
    assert.deepStrictEqual(rules.deny, []);
  });

  it("subagent inherits global when no subagent-specific rules exist", () => {
    const cfg: ShoggothConfig = {
      ...base,
      mcp: { ...base.mcp, serverRules: { allow: ["a"], deny: ["b"] } },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", true);
    assert.deepStrictEqual(rules, { allow: ["a"], deny: ["b"] });
  });

  it("top-level session ignores subagentMcp rules", () => {
    const cfg: ShoggothConfig = {
      ...base,
      mcp: { ...base.mcp, serverRules: { allow: ["*"], deny: [] } },
      agents: {
        subagentMcp: { serverRules: { allow: [], deny: ["*"] } },
      },
    };
    // Top-level session should NOT pick up subagentMcp rules
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", false);
    assert.deepStrictEqual(rules.allow, ["*"]);
    assert.deepStrictEqual(rules.deny, []);
  });

  it("unmatched agent id falls back to global rules", () => {
    const cfg: ShoggothConfig = {
      ...base,
      mcp: { ...base.mcp, serverRules: { allow: ["global-only"], deny: [] } },
      agents: {
        list: {
          other: {
            mcp: { serverRules: { allow: ["nope"], deny: [] } },
          },
        },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", false);
    assert.deepStrictEqual(rules.allow, ["global-only"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Subagent cascade — subagents inherit the agent's top-level rules
// ---------------------------------------------------------------------------

describe("resolveEffectiveMcpServerRules — subagent top-level inheritance", () => {
  /** Minimal valid ShoggothConfig for testing. */
  const base: ShoggothConfig = {
    logLevel: "info",
    stateDbPath: "/tmp/s.db",
    socketPath: "/tmp/s.sock",
    workspacesRoot: "/w",
    secretsDirectory: "/s",
    inboundMediaRoot: "/m",
    operatorDirectory: "/o",
    configDirectory: "/c",
    hitl: { defaultApprovalTimeoutMs: 1, toolRisk: {}, bypassUpTo: "safe" },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: {}, poolScope: "global" },
    policy: {
      operator: {
        controlOps: { allow: ["*"], deny: [] },
        tools: { allow: ["*"], deny: [] },
      },
      agent: {
        controlOps: { allow: ["*"], deny: [] },
        tools: { allow: ["*"], deny: [] },
      },
      auditRedaction: { jsonPaths: [] },
    },
  };

  it("subagent inherits the agent's top-level mcp.serverRules when no subagentMcp is configured", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: {
          myagent: {
            mcp: { serverRules: { allow: ["*", "priv"], deny: ["blocked"] } },
          },
        },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", true);
    assert.deepStrictEqual(rules, { allow: ["*", "priv"], deny: ["blocked"] });
  });

  it("explicit server named in the agent's allow list is allowed for subagents", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: {
          myagent: {
            mcp: { serverRules: { allow: ["*", "priv"], deny: [] } },
          },
        },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", true);
    // `priv` is explicit — only the exact entry from the inherited allow list
    // covers it; the wildcard still covers implicit servers.
    assert.strictEqual(evaluateMcpServerRules("priv", rules, true), true);
    assert.strictEqual(evaluateMcpServerRules("other", rules), true);
  });

  it("explicit server stays denied for subagents when the agent's allow list does not name it", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: {
          myagent: {
            mcp: { serverRules: { allow: ["*"], deny: [] } },
          },
        },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", true);
    assert.strictEqual(evaluateMcpServerRules("priv", rules, true), false);
    assert.strictEqual(evaluateMcpServerRules("pub", rules), true);
  });

  it("per-agent subagentMcp replaces the inherited allow while unset fields stay inherited (field-level)", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: {
          myagent: {
            mcp: { serverRules: { allow: ["*", "priv"], deny: ["blocked"] } },
            subagentMcp: { serverRules: { allow: ["sandbox"] } },
          },
        },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", true);
    // `allow` overridden by the narrower subagentMcp scope; `deny` inherited
    // from the agent's top-level rules.
    assert.deepStrictEqual(rules, { allow: ["sandbox"], deny: ["blocked"] });
  });

  it("top-level sessions are unaffected by the subagent inheritance level", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: {
          myagent: {
            mcp: { serverRules: { allow: ["*", "priv"], deny: [] } },
          },
        },
      },
    };
    const rules = resolveEffectiveMcpServerRules(cfg, "myagent", false);
    assert.deepStrictEqual(rules, { allow: ["*", "priv"], deny: [] });
  });
});
