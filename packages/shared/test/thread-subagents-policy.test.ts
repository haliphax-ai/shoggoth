import { describe, it } from "vitest";
import assert from "node:assert";
import { shoggothAgentsConfigSchema } from "../src/schema.js";
import { effectiveThreadSubagentsEnabled } from "../src/thread-subagents-policy.js";

function cfg(partial: unknown) {
  return partial as { agents?: { threadSubagents?: boolean } };
}

describe("agents.threadSubagents config", () => {
  describe("schema", () => {
    it("accepts the toggle unset (default)", () => {
      const r = shoggothAgentsConfigSchema.safeParse({});
      assert.equal(r.success, true);
    });

    it("accepts threadSubagents as a boolean", () => {
      assert.equal(shoggothAgentsConfigSchema.safeParse({ threadSubagents: true }).success, true);
      assert.equal(shoggothAgentsConfigSchema.safeParse({ threadSubagents: false }).success, true);
    });

    it("rejects a non-boolean toggle", () => {
      assert.equal(shoggothAgentsConfigSchema.safeParse({ threadSubagents: "yes" }).success, false);
    });
  });

  describe("effectiveThreadSubagentsEnabled", () => {
    it("defaults to enabled when unset", () => {
      assert.equal(effectiveThreadSubagentsEnabled(cfg({})), true);
      assert.equal(effectiveThreadSubagentsEnabled(cfg({ agents: {} })), true);
      assert.equal(effectiveThreadSubagentsEnabled(cfg({ agents: { list: { a: {} } } })), true);
    });

    it("disabled when agents.threadSubagents is false", () => {
      assert.equal(
        effectiveThreadSubagentsEnabled(cfg({ agents: { threadSubagents: false } })),
        false,
      );
    });

    it("enabled when agents.threadSubagents is true", () => {
      assert.equal(
        effectiveThreadSubagentsEnabled(cfg({ agents: { threadSubagents: true } })),
        true,
      );
    });
  });
});
