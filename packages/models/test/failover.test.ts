import { describe, it } from "node:test";
import assert from "node:assert";
import { createFailoverModelClient } from "../src/failover";
import type { ModelProvider } from "../src/types";
import { ModelHttpError } from "../src/errors";

function mockProvider(
  id: string,
  behavior: "ok" | "503" | "429",
  content?: string,
): ModelProvider {
  return {
    id,
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
});
