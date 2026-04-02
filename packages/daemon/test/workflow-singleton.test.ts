import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";

// We need to test the singleton in isolation. Since it uses module-level state,
// we use dynamic imports with cache busting isn't possible in node:test easily.
// Instead, we test the executeWorkflowToolCall function behavior.

describe("workflow-singleton", () => {
  describe("executeWorkflowToolCall before init", async () => {
    it("returns error when server is not initialized", async () => {
      // Fresh import — singleton not initialized in this test process
      const mod = await import("../src/workflow-singleton.js");

      // getWorkflowServer should be undefined before init
      assert.equal(mod.getWorkflowServer(), undefined);
      assert.equal(mod.getWorkflowControlPlane(), undefined);

      const result = await mod.executeWorkflowToolCall(
        { action: "list" } as Parameters<typeof mod.executeWorkflowToolCall>[0],
        { currentDepth: 0, maxDepth: 2 },
      );

      assert.equal(result.ok, false);
      assert.match(result.error!, /not initialized/);
    });
  });

  describe("initWorkflow", async () => {
    it("initializes server and control plane", async () => {
      const mod = await import("../src/workflow-singleton.js");
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs");
      const { randomUUID } = await import("node:crypto");

      const tmpDir = path.join(os.tmpdir(), `workflow-test-${randomUUID()}`);

      const result = mod.initWorkflow({
        stateDir: tmpDir,
        spawner: { async spawn() { return "stub-session"; } },
        poller: { async poll() { return { status: "running" as const }; } },
        notifier: { async notify() {} },
        killer: { async kill() {} },
        messageAdapter: null,
      });

      assert.ok(result.server);
      assert.ok(result.controlPlane);
      assert.ok(mod.getWorkflowServer());
      assert.ok(mod.getWorkflowControlPlane());

      // State dir should have been created
      assert.ok(fs.existsSync(tmpDir));

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns existing instances on repeated calls", async () => {
      const mod = await import("../src/workflow-singleton.js");

      const first = mod.getWorkflowServer();
      const os = await import("node:os");
      const path = await import("node:path");
      const { randomUUID } = await import("node:crypto");

      const tmpDir = path.join(os.tmpdir(), `workflow-test-${randomUUID()}`);

      const result = mod.initWorkflow({
        stateDir: tmpDir,
        spawner: { async spawn() { return "other-session"; } },
        poller: { async poll() { return { status: "running" as const }; } },
        notifier: { async notify() {} },
        killer: { async kill() {} },
        messageAdapter: null,
      });

      // Should return the same instance, not create a new one
      assert.equal(result.server, first ?? result.server);
    });
  });

  describe("executeWorkflowToolCall after init", async () => {
    it("routes list action to control plane", async () => {
      const mod = await import("../src/workflow-singleton.js");

      const result = await mod.executeWorkflowToolCall(
        { action: "list" } as Parameters<typeof mod.executeWorkflowToolCall>[0],
        { currentDepth: 0, maxDepth: 2 },
      );

      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.data));
    });

    it("routes start action and validates required fields", async () => {
      const mod = await import("../src/workflow-singleton.js");

      const result = await mod.executeWorkflowToolCall(
        { action: "start" } as Parameters<typeof mod.executeWorkflowToolCall>[0],
        { currentDepth: 0, maxDepth: 2 },
      );

      assert.equal(result.ok, false);
      assert.match(result.error!, /tasks/);
    });

    it("routes status action and validates workflow_id", async () => {
      const mod = await import("../src/workflow-singleton.js");

      const result = await mod.executeWorkflowToolCall(
        { action: "status" } as Parameters<typeof mod.executeWorkflowToolCall>[0],
        { currentDepth: 0, maxDepth: 2 },
      );

      assert.equal(result.ok, false);
      assert.match(result.error!, /workflow_id/);
    });

    it("routes unknown action and returns error", async () => {
      const mod = await import("../src/workflow-singleton.js");

      const result = await mod.executeWorkflowToolCall(
        { action: "explode" } as unknown as Parameters<typeof mod.executeWorkflowToolCall>[0],
        { currentDepth: 0, maxDepth: 2 },
      );

      assert.equal(result.ok, false);
      assert.match(result.error!, /Unknown action/);
    });
  });
});
