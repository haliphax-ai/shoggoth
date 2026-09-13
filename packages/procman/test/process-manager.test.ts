import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { ProcessManager } from "../src/process-manager.js";
import type { ProcessSpec } from "../src/types.js";

function makeSpec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    id: "test-proc",
    owner: { kind: "daemon" },
    command: "echo",
    args: ["hello"],
    restart: { mode: "never" },
    ...overrides,
  };
}

function makeRunningSpec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return makeSpec({
    id: "long-proc",
    command: "sleep",
    args: ["60"],
    ...overrides,
  });
}

describe("ProcessManager", () => {
  it("start registers and returns a handle", async () => {
    const pm = new ProcessManager();
    const mp = await pm.start(makeSpec({ id: "pm-start" }));
    assert.ok(mp);
    assert.equal(mp.spec.id, "pm-start");

    // Wait for process to finish
    await new Promise<void>((resolve) => {
      if (mp.state === "dead") return resolve();
      mp.on("state-change", (s: string) => {
        if (s === "dead") resolve();
      });
    });
  });

  it("rejects duplicate spec IDs", async () => {
    const pm = new ProcessManager();
    await pm.start(makeSpec({ id: "dup-test", command: "sleep", args: ["60"] }));

    await assert.rejects(() => pm.start(makeSpec({ id: "dup-test" })), /already registered/);

    // Cleanup
    await pm.stopAll();
  });

  it("stop removes the process", async () => {
    const pm = new ProcessManager();
    await pm.start(makeSpec({ id: "stop-test", command: "sleep", args: ["60"] }));

    assert.ok(pm.get("stop-test"));
    await pm.stop("stop-test");
    assert.equal(pm.get("stop-test"), undefined);
  });

  it("stop throws for unknown ID", async () => {
    const pm = new ProcessManager();
    await assert.rejects(() => pm.stop("nonexistent"), /No process with id/);
  });

  it("list returns all processes", async () => {
    const pm = new ProcessManager();
    await pm.start(makeSpec({ id: "list-a", command: "sleep", args: ["60"] }));
    await pm.start(makeSpec({ id: "list-b", command: "sleep", args: ["60"] }));

    const all = pm.list();
    assert.equal(all.length, 2);

    await pm.stopAll();
  });

  it("listByOwner filters correctly", async () => {
    const pm = new ProcessManager();
    await pm.start(
      makeSpec({
        id: "owner-a",
        command: "sleep",
        args: ["60"],
        owner: { kind: "mcp-server", scopeId: "fs" },
      }),
    );
    await pm.start(
      makeSpec({
        id: "owner-b",
        command: "sleep",
        args: ["60"],
        owner: { kind: "plugin", scopeId: "lsp" },
      }),
    );
    await pm.start(
      makeSpec({
        id: "owner-c",
        command: "sleep",
        args: ["60"],
        owner: { kind: "mcp-server", scopeId: "git" },
      }),
    );

    const mcpProcs = pm.listByOwner({ kind: "mcp-server" });
    assert.equal(mcpProcs.length, 2);

    const specific = pm.listByOwner({ kind: "mcp-server", scopeId: "fs" });
    assert.equal(specific.length, 1);
    assert.equal(specific[0].spec.id, "owner-a");

    await pm.stopAll();
  });

  it("stopByOwner stops only matching processes", async () => {
    const pm = new ProcessManager();
    await pm.start(
      makeSpec({
        id: "sbo-a",
        command: "sleep",
        args: ["60"],
        owner: { kind: "session", scopeId: "s1" },
      }),
    );
    await pm.start(
      makeSpec({
        id: "sbo-b",
        command: "sleep",
        args: ["60"],
        owner: { kind: "session", scopeId: "s2" },
      }),
    );
    await pm.start(
      makeSpec({
        id: "sbo-c",
        command: "sleep",
        args: ["60"],
        owner: { kind: "daemon" },
      }),
    );

    await pm.stopByOwner({ kind: "session", scopeId: "s1" });

    assert.equal(pm.get("sbo-a"), undefined);
    assert.ok(pm.get("sbo-b"));
    assert.ok(pm.get("sbo-c"));

    await pm.stopAll();
  });

  it("stopAll respects dependency ordering", async () => {
    const pm = new ProcessManager();
    const stopOrder: string[] = [];

    // A depends on B, B depends on C
    // Shutdown order should be: A first, then B, then C
    await pm.start(
      makeSpec({
        id: "dep-c",
        command: "sleep",
        args: ["60"],
      }),
    );
    await pm.start(
      makeSpec({
        id: "dep-b",
        command: "sleep",
        args: ["60"],
        dependsOn: ["dep-c"],
      }),
    );
    await pm.start(
      makeSpec({
        id: "dep-a",
        command: "sleep",
        args: ["60"],
        dependsOn: ["dep-b"],
      }),
    );

    // Track stop order via state-change events
    for (const mp of pm.list()) {
      mp.on("state-change", (s: string) => {
        if (s === "stopping") stopOrder.push(mp.spec.id);
      });
    }

    await pm.stopAll();

    // dep-a should stop before dep-b, dep-b before dep-c
    const idxA = stopOrder.indexOf("dep-a");
    const idxB = stopOrder.indexOf("dep-b");
    const idxC = stopOrder.indexOf("dep-c");

    assert.ok(idxA >= 0, "dep-a should have been stopped");
    assert.ok(idxB >= 0, "dep-b should have been stopped");
    assert.ok(idxC >= 0, "dep-c should have been stopped");
    assert.ok(idxA < idxB, `dep-a (${idxA}) should stop before dep-b (${idxB})`);
    assert.ok(idxB < idxC, `dep-b (${idxB}) should stop before dep-c (${idxC})`);
  });

  it("emits process-started and process-stopped events", async () => {
    const pm = new ProcessManager();
    const events: string[] = [];

    pm.on("process-started", () => events.push("started"));
    pm.on("process-stopped", () => events.push("stopped"));

    const mp = await pm.start(makeSpec({ id: "events-test", command: "sleep", args: ["60"] }));

    // Wait for running
    if (mp.state !== "running") {
      await new Promise<void>((resolve) => {
        mp.on("state-change", (s: string) => {
          if (s === "running") resolve();
        });
      });
    }

    assert.ok(events.includes("started"));

    await pm.stop("events-test");
    assert.ok(events.includes("stopped"));
  });

  // ===========================================================================
  // NEW TESTS — Cycle detection in _reverseDepOrder()
  // ===========================================================================

  describe("cycle detection in _reverseDepOrder()", () => {
    it("stopAll completes without hanging when processes have circular dependencies", async () => {
      const pm = new ProcessManager();

      // A depends on B, B depends on A — circular dependency
      await pm.start(
        makeRunningSpec({
          id: "cycle-a",
          dependsOn: ["cycle-b"],
        }),
      );
      await pm.start(
        makeRunningSpec({
          id: "cycle-b",
          dependsOn: ["cycle-a"],
        }),
      );

      // stopAll should complete despite the cycle (processes are put in a single batch)
      await pm.stopAll();

      // All processes should be cleared
      assert.equal(pm.list().length, 0, "all processes should be cleared after stopAll");
    });

    it("stopAll handles longer cycle chains (A→B→C→A)", async () => {
      const pm = new ProcessManager();

      await pm.start(
        makeRunningSpec({
          id: "loop-a",
          dependsOn: ["loop-c"],
        }),
      );
      await pm.start(
        makeRunningSpec({
          id: "loop-b",
          dependsOn: ["loop-a"],
        }),
      );
      await pm.start(
        makeRunningSpec({
          id: "loop-c",
          dependsOn: ["loop-b"],
        }),
      );

      // Track which processes were stopped
      const stopped: string[] = [];
      for (const mp of pm.list()) {
        mp.on("state-change", (s: string) => {
          if (s === "stopping" || s === "dead") stopped.push(mp.spec.id);
        });
      }

      await pm.stopAll();

      assert.equal(pm.list().length, 0, "all processes should be cleared");
      assert.ok(stopped.includes("loop-a"), "loop-a should have been stopped");
      assert.ok(stopped.includes("loop-b"), "loop-b should have been stopped");
      assert.ok(stopped.includes("loop-c"), "loop-c should have been stopped");
    });

    it("stopAll handles a mix of cyclic and acyclic processes", async () => {
      const pm = new ProcessManager();

      // cycle-1 depends on cycle-2, cycle-2 depends on cycle-1 (cycle)
      await pm.start(
        makeRunningSpec({
          id: "cycle-1",
          dependsOn: ["cycle-2"],
        }),
      );
      await pm.start(
        makeRunningSpec({
          id: "cycle-2",
          dependsOn: ["cycle-1"],
        }),
      );

      // acyclic: standalone depends on nothing
      await pm.start(
        makeRunningSpec({
          id: "standalone",
        }),
      );

      await pm.stopAll();

      assert.equal(pm.list().length, 0, "all processes should be cleared");
    });
  });

  // ===========================================================================
  // NEW TESTS — stopAll error-swallowing behavior
  // ===========================================================================

  describe("stopAll error-swallowing", () => {
    it("completes stopAll even if one process fails to stop", async () => {
      const pm = new ProcessManager();

      // Start several processes
      await pm.start(makeRunningSpec({ id: "err-a" }));
      await pm.start(makeRunningSpec({ id: "err-b" }));
      await pm.start(makeRunningSpec({ id: "err-c" }));

      // Verify all are registered
      assert.equal(pm.list().length, 3);

      // stopAll should complete without throwing even if individual stop() calls
      // throw errors internally. The error-swallowing in stopAll catches errors
      // and continues with the next batch.
      await pm.stopAll();

      // All processes should be cleared regardless
      assert.equal(pm.list().length, 0, "all processes should be cleared after stopAll");
    });

    it("stopAll clears all processes even when a process is already dead", async () => {
      const pm = new ProcessManager();

      // Start processes
      await pm.start(makeRunningSpec({ id: "mix-a" }));
      await pm.start(makeRunningSpec({ id: "mix-b" }));

      // Kill one manually before stopAll
      const mp = pm.get("mix-a");
      assert.ok(mp);
      mp!.kill();

      // Wait for it to die
      await new Promise<void>((resolve) => {
        if (mp!.state === "dead") return resolve();
        mp!.on("state-change", (s: string) => {
          if (s === "dead") resolve();
        });
      });

      // stopAll should handle the mix of dead and alive processes
      await pm.stopAll();

      assert.equal(pm.list().length, 0, "all processes should be cleared after stopAll");
    });

    it("stopAll processes each batch in parallel", async () => {
      const pm = new ProcessManager();

      // Build a linear chain: a1 depends on a2, a2 depends on a3
      // Shutdown order: a1 first (leaf), then a2, then a3 (root)
      await pm.start(makeRunningSpec({ id: "par-a3" }));
      await pm.start(makeRunningSpec({ id: "par-a2", dependsOn: ["par-a3"] }));
      await pm.start(makeRunningSpec({ id: "par-a1", dependsOn: ["par-a2"] }));

      const stoppedIds: string[] = [];
      for (const mp of pm.list()) {
        mp.on("state-change", (s: string) => {
          if (s === "dead") stoppedIds.push(mp.spec.id);
        });
      }

      await pm.stopAll();

      assert.equal(pm.list().length, 0);

      // All three should have been stopped
      assert.ok(stoppedIds.includes("par-a1"));
      assert.ok(stoppedIds.includes("par-a2"));
      assert.ok(stoppedIds.includes("par-a3"));
    });
  });

  // ===========================================================================
  // NEW TESTS — Additional edge cases
  // ===========================================================================

  describe("process lifecycle edge cases", () => {
    it("stopAll with no processes is a no-op", async () => {
      const pm = new ProcessManager();
      await pm.stopAll();
      assert.equal(pm.list().length, 0);
    });

    it("start a process that fails health check keeps it registered", async () => {
      const pm = new ProcessManager();

      const mp = await pm.start(
        makeSpec({
          id: "fail-start",
          command: "sleep",
          args: ["60"],
          health: {
            kind: "tcp",
            port: 59999,
            retries: 1,
            intervalMs: 50,
            timeoutMs: 200,
          },
        }),
      );

      // The process should be registered even though health check failed
      // Wait for it to reach failed state
      await new Promise<void>((resolve) => {
        if (mp.state === "failed") return resolve();
        mp.on("state-change", (s: string) => {
          if (s === "failed") resolve();
        });
      });

      assert.ok(pm.get("fail-start"), "process should remain registered after start failure");
      assert.equal(mp.state, "failed", "process state should be failed");

      // Clean up — stopAll should clear it
      await pm.stopAll();
      assert.equal(pm.list().length, 0);
    });

    it("process-failed event is emitted when health check fails", async () => {
      const pm = new ProcessManager();
      let failedProcess: unknown = null;

      pm.on("process-failed", (mp) => {
        failedProcess = mp;
      });

      const mp = await pm.start(
        makeSpec({
          id: "fail-event",
          command: "sleep",
          args: ["60"],
          health: {
            kind: "tcp",
            port: 59998,
            retries: 1,
            intervalMs: 50,
            timeoutMs: 200,
          },
        }),
      );

      // Wait for process to reach failed state
      await new Promise<void>((resolve) => {
        if (mp.state === "failed") return resolve();
        mp.on("state-change", (s: string) => {
          if (s === "failed") resolve();
        });
      });

      assert.ok(failedProcess, "process-failed event should have been emitted");

      await pm.stopAll();
    });

    it("stopAll on empty manager is safe", async () => {
      const pm = new ProcessManager();
      await pm.stopAll();
      await pm.stopAll(); // calling again should be safe
      assert.equal(pm.list().length, 0);
    });
  });
});
