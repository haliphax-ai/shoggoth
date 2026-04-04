import { describe, it } from "vitest";
import assert from "node:assert";
import { createFailoverToolCallingClient } from "../src/tool-failover";
import type { ModelProvider, ModelCapabilities } from "../src/types";
import { ModelHttpError } from "../src/errors";

function mockToolProvider(
  id: string,
  behavior: "ok" | "503",
  content?: string,
  toolCalls?: { id: string; name: string; arguments: string }[],
  capabilities?: ModelCapabilities,
): ModelProvider {
  return {
    id,
    capabilities,
    async complete() {
      return { content: content ?? "ok" };
    },
    async completeWithTools() {
      if (behavior === "503") throw new ModelHttpError(503, "down");
      return { content: content ?? "ok", toolCalls: toolCalls ?? [] };
    },
  };
}

describe("createFailoverToolCallingClient", () => {
  it("uses first provider and marks degraded after failover", async () => {
    const c = createFailoverToolCallingClient([
      { provider: mockToolProvider("a", "503"), model: "m1" },
      { provider: mockToolProvider("b", "ok", "backup"), model: "m2" },
    ]);
    const r = await c.completeWithTools({
      messages: [{ role: "user", content: "x" }],
      tools: [],
    });
    assert.equal(r.content, "backup");
    assert.equal(r.usedProviderId, "b");
    assert.equal(r.degraded, true);
  });

  it("returns tool calls from chosen provider", async () => {
    const c = createFailoverToolCallingClient([
      {
        provider: mockToolProvider("a", "ok", undefined, [
          { id: "t1", name: "builtin-read", arguments: "{}" },
        ]),
        model: "m",
      },
    ]);
    const r = await c.completeWithTools({
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "builtin-read", parameters: {} } }],
    });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0]!.name, "builtin-read");
  });

  describe("thinkingFormat propagation", () => {
    it("propagates thinkingFormat from active hop provider", async () => {
      const c = createFailoverToolCallingClient([
        {
          provider: mockToolProvider("a", "ok", "x", [], { thinkingFormat: "native" }),
          model: "m1",
        },
      ]);
      const r = await c.completeWithTools({
        messages: [{ role: "user", content: "x" }],
        tools: [],
      });
      assert.equal(r.thinkingFormat, "native");
    });

    it("propagates thinkingFormat on failover to backup hop", async () => {
      const c = createFailoverToolCallingClient([
        { provider: mockToolProvider("a", "503"), model: "m1" },
        {
          provider: mockToolProvider("b", "ok", "backup", [], { thinkingFormat: "xml-tags" }),
          model: "m2",
        },
      ]);
      const r = await c.completeWithTools({
        messages: [{ role: "user", content: "x" }],
        tools: [],
      });
      assert.equal(r.thinkingFormat, "xml-tags");
      assert.equal(r.degraded, true);
    });

    it("returns undefined thinkingFormat when provider has none", async () => {
      const c = createFailoverToolCallingClient([
        { provider: mockToolProvider("a", "ok", "x"), model: "m1" },
      ]);
      const r = await c.completeWithTools({
        messages: [{ role: "user", content: "x" }],
        tools: [],
      });
      assert.equal(r.thinkingFormat, undefined);
    });
  });
});
