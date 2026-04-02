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

describe("ProcessManager", () => {
  it("start registers and returns a handle", async () => {
    const pm = new ProcessManager();
    const mp = await pm.start(makeSpec({ id: "pm-start" }));
    assert.ok(mp);
    assert.equal(mp.spec.id, "pm-start");

    // Wait for process to finish
    await new Promise<void>((resolve) => {
      if (mp.state === "dead") return resolve();
      mp.on("state-change", (s: string) => { if (s === "dead") resolve(); });
    });
  });

  it("rejects duplicate spec IDs", async () => {
    const pm = new ProcessManager();
    await pm.start(makeSpec({ id: "dup-test", command: "sleep", args: ["60"] }));

    await assert.rejects(
      () => pm.start(makeSpec({ id: "dup-test" })),
      /already registered/,
    );

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
    await assert.rejects(
      () => pm.stop("nonexistent"),
      /No process with id/,
    );
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
    await pm.start(makeSpec({
      id: "owner-a",
      command: "sleep",
      args: ["60"],
      owner: { kind: "mcp-server", scopeId: "fs" },
    }));
    await pm.start(makeSpec({
      id: "owner-b",
      command: "sleep",
      args: ["60"],
      owner: { kind: "plugin", scopeId: "lsp" },
    }));
    await pm.start(makeSpec({
      id: "owner-c",
      command: "sleep",
      args: ["60"],
      owner: { kind: "mcp-server", scopeId: "git" },
    }));

    const mcpProcs = pm.listByOwner({ kind: "mcp-server" });
    assert.equal(mcpProcs.length, 2);

    const specific = pm.listByOwner({ kind: "mcp-server", scopeId: "fs" });
    assert.equal(specific.length, 1);
    assert.equal(specific[0].spec.id, "owner-a");

    await pm.stopAll();
  });

  it("stopByOwner stops only matching processes", async () => {
    const pm = new ProcessManager();
    await pm.start(makeSpec({
      id: "sbo-a",
      command: "sleep",
      args: ["60"],
      owner: { kind: "session", scopeId: "s1" },
    }));
    await pm.start(makeSpec({
      id: "sbo-b",
      command: "sleep",
      args: ["60"],
      owner: { kind: "session", scopeId: "s2" },
    }));
    await pm.start(makeSpec({
      id: "sbo-c",
      command: "sleep",
      args: ["60"],
      owner: { kind: "daemon" },
    }));

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
    await pm.start(makeSpec({
      id: "dep-c",
      command: "sleep",
      args: ["60"],
    }));
    await pm.start(makeSpec({
      id: "dep-b",
      command: "sleep",
      args: ["60"],
      dependsOn: ["dep-c"],
    }));
    await pm.start(makeSpec({
      id: "dep-a",
      command: "sleep",
      args: ["60"],
      dependsOn: ["dep-b"],
    }));

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
        mp.on("state-change", (s: string) => { if (s === "running") resolve(); });
      });
    }

    assert.ok(events.includes("started"));

    await pm.stop("events-test");
    assert.ok(events.includes("stopped"));
  });
});
