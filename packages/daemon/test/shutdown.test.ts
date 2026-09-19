import { describe, it, vi } from "vitest";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createLogger } from "../src/logging";
import { ShutdownCoordinator } from "../src/shutdown";
import { installSignalHandlers } from "../src/signals";

describe("ShutdownCoordinator", () => {
  it("runs drains in order then marks interrupted", async () => {
    const order: string[] = [];
    const log = createLogger({ component: "t", minLevel: "error" });
    const mark = vi.fn(async () => {
      order.push("mark");
    });
    const s = new ShutdownCoordinator({
      logger: log,
      drainTimeoutMs: 5000,
      markInterruptedRunsFailed: mark,
    });
    s.registerDrain("a", async () => {
      order.push("a");
    });
    s.registerDrain("b", async () => {
      order.push("b");
    });
    await s.requestShutdown("test");
    assert.deepEqual(order, ["a", "b", "mark"]);
    assert.equal(mark.mock.calls.length, 1);
    await s.finished;
  });

  it("runs drains in the same group in parallel", async () => {
    const order: string[] = [];
    const log = createLogger({ component: "t", minLevel: "error" });
    const s = new ShutdownCoordinator({
      logger: log,
      drainTimeoutMs: 5000,
    });

    // Group 1: two drains that take time — should run in parallel
    s.registerDrain(
      "fast",
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("fast");
      },
      { group: 1 },
    );
    s.registerDrain(
      "slow",
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push("slow");
      },
      { group: 1 },
    );

    // Group 2: runs after group 1
    s.registerDrain(
      "last",
      async () => {
        order.push("last");
      },
      { group: 2 },
    );

    const start = Date.now();
    await s.requestShutdown("test");
    const elapsed = Date.now() - start;

    // fast and slow ran in parallel, so total time should be ~50ms, not ~70ms
    assert.ok(elapsed < 100, `expected parallel execution, took ${elapsed}ms`);
    // Both group-1 drains completed before group-2
    assert.ok(order.indexOf("fast") < order.indexOf("last"));
    assert.ok(order.indexOf("slow") < order.indexOf("last"));
    await s.finished;
  });

  it("invokes markInterruptedRunsFailed on timeout", async () => {
    const log = createLogger({ component: "t", minLevel: "error" });
    const mark = vi.fn(async () => {});
    const s = new ShutdownCoordinator({
      logger: log,
      drainTimeoutMs: 30,
      markInterruptedRunsFailed: mark,
    });
    s.registerDrain("slow", () => new Promise<void>(() => {}));
    await s.requestShutdown("sig");
    assert.equal(mark.mock.calls.length, 1);
    const first = mark.mock.calls[0] as unknown[] | undefined;
    const reason = String(first?.[0] ?? "");
    assert.match(reason, /timeout/);
  });
});

describe("installSignalHandlers", () => {
  it("invokes onSignal when fake process emits", async () => {
    const ee = new EventEmitter() as NodeJS.Process;
    (ee as unknown as { pid: number }).pid = 42;
    const log = createLogger({ component: "t", minLevel: "error" });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const onSignal = vi.fn(async (_s: NodeJS.Signals) => {});
    const dispose = installSignalHandlers({
      logger: log,
      proc: ee,
      signals: ["SIGUSR2"] as NodeJS.Signals[],
      onSignal,
    });
    ee.emit("SIGUSR2");
    await new Promise((r) => setImmediate(r));
    assert.equal(onSignal.mock.calls.length, 1);
    dispose();
    ee.emit("SIGUSR2");
    await new Promise((r) => setImmediate(r));
    assert.equal(onSignal.mock.calls.length, 1);
  });
});
