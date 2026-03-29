import { describe, it } from "node:test";
import assert from "node:assert";
import { createHitlResolutionHub } from "../../src/hitl/hitl-resolution-hub";

describe("createHitlResolutionHub", () => {
  it("resolves waitFor after notifyResolved", async () => {
    const hub = createHitlResolutionHub();
    const p = hub.waitFor("a1");
    hub.notifyResolved("a1", "approved");
    assert.equal(await p, "approved");
  });

  it("buffers notify before waitFor", async () => {
    const hub = createHitlResolutionHub();
    hub.notifyResolved("x1", "denied");
    assert.equal(await hub.waitFor("x1"), "denied");
  });
});
