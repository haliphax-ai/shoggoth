import { describe, it } from "vitest";
import assert from "node:assert";
import { createFailoverModelClient } from "../src/failover";
import type { FailoverHooks } from "../src/failover";
import type { ModelProvider, ModelCapabilities } from "../src/types";
import { ModelHttpError } from "../src/errors";

function mockProvider(
  id: string,
  behavior: "ok" | "503" | "429",
  content?: string,
  capabilities?: ModelCapabilities,
): ModelProvider {
  return {
    id,
    capabilities,
    async complete() {
      if (behavior === "ok") return { content: content ?? "ok" };
      if (behavior === "503") throw new ModelHttpError(503, "down");
      throw new ModelHttpError(429, "rate");
    },
    async completeWithTools() {
      if (behavior === "ok") return { content: content ?? "ok", toolCalls: [] };
      if (behavior === "503") throw new ModelHttpError(503, "down");
      throw new ModelHttpError(429, "rate");
    },
  };
}

describe("createFailoverModelClient", () => {
  it("uses first healthy entry in the chain", async () => {
    const c = createFailoverModelClient([
      { provider: mockProvider("a", "ok", "first"), model: "m1" },
      { provider: mockProvider("b", "ok", "second"), model: "m2" },
    ]);
    const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(r.content, "first");
    assert.equal(r.usedProviderId, "a");
    assert.equal(r.usedModel, "m1");
    assert.equal(r.degraded, false);
  });

  it("failovers on eligible errors and records degraded when not first", async () => {
    const c = createFailoverModelClient([
      { provider: mockProvider("a", "503"), model: "m1" },
      { provider: mockProvider("b", "ok", "backup"), model: "m2" },
    ]);
    const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(r.content, "backup");
    assert.equal(r.usedProviderId, "b");
    assert.equal(r.degraded, true);
  });

  it("uses explicit per-entry model override", async () => {
    const c = createFailoverModelClient([
      { provider: mockProvider("a", "ok", "x"), model: "custom" },
    ]);
    const r = await c.complete({
      model: "ignored",
      messages: [{ role: "user", content: "u" }],
    });
    assert.equal(r.usedModel, "custom");
  });

  it("throws after chain exhaustion", async () => {
    const c = createFailoverModelClient([
      { provider: mockProvider("a", "503"), model: "m1" },
      { provider: mockProvider("b", "503"), model: "m2" },
    ]);
    await assert.rejects(() =>
      c.complete({ messages: [{ role: "user", content: "x" }] }),
    );
  });

  it("does not failover on 401", async () => {
    const c = createFailoverModelClient([
      {
        provider: {
          id: "a",
          async complete() {
            throw new ModelHttpError(401, "bad key");
          },
          async completeWithTools() {
            throw new ModelHttpError(401, "bad key");
          },
        },
        model: "m1",
      },
      { provider: mockProvider("b", "ok", "never"), model: "m2" },
    ]);
    await assert.rejects(
      () => c.complete({ messages: [{ role: "user", content: "x" }] }),
      (e: unknown) => e instanceof ModelHttpError && e.status === 401,
    );
  });

  describe("thinkingFormat propagation", () => {
    it("propagates thinkingFormat from active hop provider", async () => {
      const c = createFailoverModelClient([
        {
          provider: mockProvider("a", "ok", "x", { thinkingFormat: "native" }),
          model: "m1",
        },
      ]);
      const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
      assert.equal(r.thinkingFormat, "native");
    });

    it("propagates thinkingFormat on failover to backup hop", async () => {
      const c = createFailoverModelClient([
        { provider: mockProvider("a", "503"), model: "m1" },
        {
          provider: mockProvider("b", "ok", "backup", { thinkingFormat: "xml-tags" }),
          model: "m2",
        },
      ]);
      const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
      assert.equal(r.thinkingFormat, "xml-tags");
      assert.equal(r.degraded, true);
    });

    it("returns undefined thinkingFormat when provider has none", async () => {
      const c = createFailoverModelClient([
        { provider: mockProvider("a", "ok", "x"), model: "m1" },
      ]);
      const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
      assert.equal(r.thinkingFormat, undefined);
    });
  });

  describe("FailoverHooks integration", () => {
    it("skips providers marked as failed via isProviderFailed", async () => {
      const hooks: FailoverHooks = {
        isProviderFailed: (id) => id === "a",
      };
      const c = createFailoverModelClient(
        [
          { provider: mockProvider("a", "ok", "first"), model: "m1" },
          { provider: mockProvider("b", "ok", "second"), model: "m2" },
        ],
        hooks,
      );
      const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
      assert.equal(r.usedProviderId, "b");
      assert.equal(r.usedModel, "m2");
      assert.equal(r.degraded, true);
    });

    it("calls onProviderSuccess on successful completion", async () => {
      const successIds: string[] = [];
      const hooks: FailoverHooks = {
        onProviderSuccess: (id) => successIds.push(id),
      };
      const c = createFailoverModelClient(
        [{ provider: mockProvider("a", "ok", "x"), model: "m1" }],
        hooks,
      );
      await c.complete({ messages: [{ role: "user", content: "x" }] });
      assert.deepEqual(successIds, ["a"]);
    });

    it("calls onProviderExhausted when failover skips a provider", async () => {
      const exhaustedIds: string[] = [];
      const hooks: FailoverHooks = {
        onProviderExhausted: (id) => exhaustedIds.push(id),
      };
      const c = createFailoverModelClient(
        [
          { provider: mockProvider("a", "503"), model: "m1" },
          { provider: mockProvider("b", "ok", "backup"), model: "m2" },
        ],
        hooks,
      );
      await c.complete({ messages: [{ role: "user", content: "x" }] });
      assert.deepEqual(exhaustedIds, ["a"]);
    });

    it("calls onProviderExhausted on last provider in chain", async () => {
      const exhaustedIds: string[] = [];
      const hooks: FailoverHooks = {
        onProviderExhausted: (id) => exhaustedIds.push(id),
      };
      const c = createFailoverModelClient(
        [
          { provider: mockProvider("a", "503"), model: "m1" },
          { provider: mockProvider("b", "503"), model: "m2" },
        ],
        hooks,
      );
      await assert.rejects(() =>
        c.complete({ messages: [{ role: "user", content: "x" }] }),
      );
      assert.deepEqual(exhaustedIds, ["a", "b"]);
    });

    it("calls onProviderSuccess after failover to clear failure state", async () => {
      const successIds: string[] = [];
      const hooks: FailoverHooks = {
        onProviderSuccess: (id) => successIds.push(id),
      };
      const c = createFailoverModelClient(
        [
          { provider: mockProvider("a", "503"), model: "m1" },
          { provider: mockProvider("b", "ok", "backup"), model: "m2" },
        ],
        hooks,
      );
      await c.complete({ messages: [{ role: "user", content: "x" }] });
      assert.deepEqual(successIds, ["b"]);
    });

    it("throws when all providers are marked failed", async () => {
      const hooks: FailoverHooks = {
        isProviderFailed: () => true,
      };
      const c = createFailoverModelClient(
        [
          { provider: mockProvider("a", "ok"), model: "m1" },
          { provider: mockProvider("b", "ok"), model: "m2" },
        ],
        hooks,
      );
      await assert.rejects(() =>
        c.complete({ messages: [{ role: "user", content: "x" }] }),
      );
    });
  });
});
