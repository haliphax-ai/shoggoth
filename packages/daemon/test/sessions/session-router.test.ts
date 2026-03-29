import { describe, it } from "node:test";
import assert from "node:assert";
import { createSessionRouter } from "../../src/sessions/session-router";

describe("SessionRouter", () => {
  it("resolves registered internal targets", () => {
    const r = createSessionRouter();
    r.register("conv:abc", "sess-1");
    assert.equal(r.resolve("conv:abc"), "sess-1");
    assert.equal(r.resolve("unknown"), undefined);
  });

  it("unregister removes mapping", () => {
    const r = createSessionRouter();
    r.register("t:1", "s");
    r.unregister("t:1");
    assert.equal(r.resolve("t:1"), undefined);
  });
});
