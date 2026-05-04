import assert from "node:assert";
import { describe, it } from "vitest";
import { shoggothMcpServerPoolScopeSchema, shoggothMcpConfigSchema } from "@shoggoth/shared";

// ---------------------------------------------------------------------------
// 1. Pool scope enum — `per_agent` support
// ---------------------------------------------------------------------------

describe("shoggothMcpServerPoolScopeSchema — per_agent value", () => {
  it("accepts 'per_agent' as a valid pool scope", () => {
    const result = shoggothMcpServerPoolScopeSchema.safeParse("per_agent");
    assert.ok(result.success, "per_agent should be a valid pool scope enum value");
  });

  it("still accepts existing values (inherit, global, per_session)", () => {
    for (const v of ["inherit", "global", "per_session"] as const) {
      const result = shoggothMcpServerPoolScopeSchema.safeParse(v);
      assert.ok(result.success, `${v} should remain valid`);
    }
  });

  it("rejects invalid values", () => {
    const result = shoggothMcpServerPoolScopeSchema.safeParse("per_workspace");
    assert.ok(!result.success);
  });
});

// ---------------------------------------------------------------------------
// 2. Top-level mcp.poolScope — accepts `per_agent`
// ---------------------------------------------------------------------------

describe("shoggothMcpConfigSchema — top-level poolScope accepts per_agent", () => {
  it("accepts poolScope: 'per_agent' at the top level", () => {
    const result = shoggothMcpConfigSchema.safeParse({
      servers: [],
      poolScope: "per_agent",
    });
    assert.ok(result.success, "top-level mcp.poolScope should accept 'per_agent'");
  });

  it("still accepts poolScope: 'global'", () => {
    const result = shoggothMcpConfigSchema.safeParse({
      servers: [],
      poolScope: "global",
    });
    assert.ok(result.success);
  });

  it("still accepts poolScope: 'per_session'", () => {
    const result = shoggothMcpConfigSchema.safeParse({
      servers: [],
      poolScope: "per_session",
    });
    assert.ok(result.success);
  });
});

// ---------------------------------------------------------------------------
// 3. perInstanceIdleTimeoutMs field (replacing perSessionIdleTimeoutMs)
// ---------------------------------------------------------------------------

describe("shoggothMcpConfigSchema — perInstanceIdleTimeoutMs field", () => {
  it("accepts perInstanceIdleTimeoutMs as a valid field", () => {
    const result = shoggothMcpConfigSchema.safeParse({
      servers: [],
      poolScope: "global",
      perInstanceIdleTimeoutMs: 60_000,
    });
    assert.ok(result.success, "perInstanceIdleTimeoutMs should be accepted on mcp config");
  });

  it("accepts perInstanceIdleTimeoutMs of 0 (disable)", () => {
    const result = shoggothMcpConfigSchema.safeParse({
      servers: [],
      poolScope: "per_agent",
      perInstanceIdleTimeoutMs: 0,
    });
    assert.ok(result.success);
  });

  it("rejects negative perInstanceIdleTimeoutMs", () => {
    const result = shoggothMcpConfigSchema.safeParse({
      servers: [],
      poolScope: "global",
      perInstanceIdleTimeoutMs: -1,
    });
    assert.ok(!result.success);
  });
});

// ---------------------------------------------------------------------------
// 4. Constant rename — SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS
// ---------------------------------------------------------------------------

describe("SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS constant", () => {
  it("is exported from @shoggoth/shared", async () => {
    // Dynamic import to test the export exists
    const mod = await import("@shoggoth/shared");
    assert.ok(
      "SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS" in mod,
      "SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS should be exported from @shoggoth/shared",
    );
  });

  it("has a numeric value (default 30 minutes)", async () => {
    const mod = await import("@shoggoth/shared");
    const value = (mod as Record<string, unknown>)["SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS"];
    assert.strictEqual(typeof value, "number");
    assert.strictEqual(value, 30 * 60 * 1000);
  });
});
