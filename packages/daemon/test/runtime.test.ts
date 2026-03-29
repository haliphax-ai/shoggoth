import { describe, it } from "node:test";
import assert from "node:assert";
import { createDaemonRuntime } from "../src/runtime";

describe("createDaemonRuntime", () => {
  it("exposes health and shutdown", async () => {
    const rt = createDaemonRuntime({
      logLevel: "error",
      shutdown: { drainTimeoutMs: 100, markInterruptedRunsFailed: async () => {} },
    });
    const h = await rt.getHealth();
    assert.equal(h.live, true);
    assert.equal(h.ready, true);
    rt.disposeSignals();
    await rt.shutdown.requestShutdown("test");
  });
});
