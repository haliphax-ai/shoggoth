import type { ShoggothMcpServerEntry } from "@shoggoth/shared";
import assert from "node:assert";
import { describe, it } from "vitest";
import { partitionMcpServersByEffectiveScope } from "../../src/mcp/mcp-server-pool";

// ---------------------------------------------------------------------------
// partitionMcpServersByEffectiveScope — per_agent support (three-way split)
// ---------------------------------------------------------------------------

describe("partitionMcpServersByEffectiveScope — per_agent", () => {
  function stdio(
    id: string,
    poolScope?: "inherit" | "global" | "per_session" | "per_agent",
  ): ShoggothMcpServerEntry {
    const base = { id, transport: "stdio" as const, command: "true" };
    return poolScope === undefined ? base : { ...base, poolScope };
  }

  it("a server with poolScope 'per_agent' lands in perAgentServers", () => {
    const result = partitionMcpServersByEffectiveScope(
      [stdio("agent-scoped", "per_agent")],
      "global",
    );
    assert.ok("perAgentServers" in result, "result should have a perAgentServers property");
    const { perAgentServers } = result as {
      globalServers: ShoggothMcpServerEntry[];
      perAgentServers: ShoggothMcpServerEntry[];
      perSessionServers: ShoggothMcpServerEntry[];
    };
    assert.deepEqual(
      perAgentServers.map((s) => s.id),
      ["agent-scoped"],
    );
  });

  it("a server with poolScope 'inherit' inherits top-level per_agent scope", () => {
    const result = partitionMcpServersByEffectiveScope(
      [stdio("inherited")],
      "per_agent" as any, // top-level per_agent not yet in the type
    );
    const { perAgentServers } = result as {
      globalServers: ShoggothMcpServerEntry[];
      perAgentServers: ShoggothMcpServerEntry[];
      perSessionServers: ShoggothMcpServerEntry[];
    };
    assert.deepEqual(
      perAgentServers.map((s) => s.id),
      ["inherited"],
    );
  });

  it("mixed scopes partition correctly into three buckets", () => {
    const servers = [
      stdio("g1", "global"),
      stdio("a1", "per_agent"),
      stdio("s1", "per_session"),
      stdio("a2", "per_agent"),
      stdio("g2"),
    ];
    const result = partitionMcpServersByEffectiveScope(servers, "global");
    const { globalServers, perAgentServers, perSessionServers } = result as {
      globalServers: ShoggothMcpServerEntry[];
      perAgentServers: ShoggothMcpServerEntry[];
      perSessionServers: ShoggothMcpServerEntry[];
    };
    assert.deepEqual(
      globalServers.map((s) => s.id),
      ["g1", "g2"],
    );
    assert.deepEqual(
      perAgentServers.map((s) => s.id),
      ["a1", "a2"],
    );
    assert.deepEqual(
      perSessionServers.map((s) => s.id),
      ["s1"],
    );
  });

  it("returns empty perAgentServers when no server uses per_agent", () => {
    const result = partitionMcpServersByEffectiveScope(
      [stdio("g1", "global"), stdio("s1", "per_session")],
      "global",
    );
    const { perAgentServers } = result as {
      globalServers: ShoggothMcpServerEntry[];
      perAgentServers: ShoggothMcpServerEntry[];
      perSessionServers: ShoggothMcpServerEntry[];
    };
    assert.deepEqual(perAgentServers, []);
  });
});
