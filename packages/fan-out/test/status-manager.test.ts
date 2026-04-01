import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { TaskList, TaskState, TaskDef, DependencyGraph } from "../src/types.js";
import type { MessageAdapter } from "../src/message-adapter.js";
import { StatusManager } from "../src/status-manager.js";

// --- Helpers ---

function makeDef(id: number, prompt: string): TaskDef {
  return { id, prompt, failureBehavior: "continue", failureNotification: "silent" };
}

function makeTask(
  id: number,
  prompt: string,
  status: TaskState["status"],
  opts: Partial<Pick<TaskState, "startedAt" | "completedAt" | "error">> = {},
): TaskState {
  return { taskDef: makeDef(id, prompt), status, ...opts };
}

function makeWorkflow(
  name: string,
  tasks: TaskState[],
  graph: DependencyGraph,
): TaskList {
  return {
    id: "wf-1",
    name,
    tasks,
    graph,
    pollingIntervalMs: 10_000,
    createdAt: Date.now(),
  };
}

class MockMessageAdapter implements MessageAdapter {
  posted: Array<{ content: string; messageId: string }> = [];
  edited: Array<{ messageId: string; content: string }> = [];
  editShouldFail = false;
  private nextId = 1;

  async postMessage(content: string): Promise<{ messageId: string }> {
    const messageId = `msg-${this.nextId++}`;
    this.posted.push({ content, messageId });
    return { messageId };
  }

  async editMessage(messageId: string, content: string): Promise<boolean> {
    if (this.editShouldFail) return false;
    this.edited.push({ messageId, content });
    return true;
  }
}

describe("StatusManager", () => {
  let adapter: MockMessageAdapter;
  let manager: StatusManager;

  beforeEach(() => {
    adapter = new MockMessageAdapter();
    manager = new StatusManager(adapter);
  });

  describe("postInitialStatus", () => {
    it("posts the formatted status message", async () => {
      const graph: DependencyGraph = new Map([
        [1, new Set()],
        [2, new Set([1])],
      ]);
      const wf = makeWorkflow("test-wf", [
        makeTask(1, "First", "pending"),
        makeTask(2, "Second", "pending"),
      ], graph);

      await manager.postInitialStatus(wf);

      assert.equal(adapter.posted.length, 1);
      assert.ok(adapter.posted[0].content.includes("**Task workflow:** test-wf"));
      assert.ok(adapter.posted[0].content.includes("⏳ 1 - First"));
      assert.ok(adapter.posted[0].content.includes("⏳ 2 [1] - Second"));
    });

    it("stores the message ID for later edits", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);
      // Verify we can update (which requires stored message ID)
      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = Date.now();
      await manager.updateStatus(wf);

      assert.equal(adapter.edited.length, 1);
      assert.equal(adapter.edited[0].messageId, "msg-1");
    });
  });

  describe("updateStatus", () => {
    it("edits the existing message with updated status", async () => {
      const now = Date.now();
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);

      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = now;
      await manager.updateStatus(wf);

      assert.equal(adapter.edited.length, 1);
      assert.ok(adapter.edited[0].content.includes("🚀 1 - Task"));
    });

    it("falls back to repost when edit fails", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);
      assert.equal(adapter.posted.length, 1);

      adapter.editShouldFail = true;
      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = Date.now();
      await manager.updateStatus(wf);

      // Should have reposted instead of edited
      assert.equal(adapter.posted.length, 2);
      assert.equal(adapter.edited.length, 0);
    });

    it("continues reposting after first edit failure", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);
      adapter.editShouldFail = true;

      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = Date.now();
      await manager.updateStatus(wf);

      // Even if edit would now succeed, should stay in repost mode
      adapter.editShouldFail = false;
      await manager.updateStatus(wf);

      // 1 initial + 2 reposts = 3 posts, 0 edits
      assert.equal(adapter.posted.length, 3);
      assert.equal(adapter.edited.length, 0);
    });

    it("does nothing if no initial status was posted", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.updateStatus(wf);

      assert.equal(adapter.posted.length, 0);
      assert.equal(adapter.edited.length, 0);
    });
  });

  describe("postSummary", () => {
    it("posts the summary message on completion", async () => {
      const graph: DependencyGraph = new Map([
        [1, new Set()],
        [2, new Set()],
      ]);
      const wf = makeWorkflow("wf", [
        makeTask(1, "A", "done", { startedAt: 0, completedAt: 60_000 }),
        makeTask(2, "B", "done", { startedAt: 0, completedAt: 120_000 }),
      ], graph);
      wf.createdAt = 0;

      await manager.postSummary(wf);

      assert.equal(adapter.posted.length, 1);
      assert.ok(adapter.posted[0].content.includes("**Task workflow complete:** wf"));
      assert.ok(adapter.posted[0].content.includes("✅ **Completed:** 2/2"));
    });

    it("includes failed tasks in summary", async () => {
      const graph: DependencyGraph = new Map([
        [1, new Set()],
        [2, new Set()],
      ]);
      const wf = makeWorkflow("wf", [
        makeTask(1, "Good", "done", { startedAt: 0, completedAt: 60_000 }),
        makeTask(2, "Bad", "failed", { startedAt: 0, completedAt: 3_000 }),
      ], graph);
      wf.createdAt = 0;

      await manager.postSummary(wf);

      assert.ok(adapter.posted[0].content.includes("❌ **Failed:** 1/2"));
      assert.ok(adapter.posted[0].content.includes("- 2 - Bad (3s)"));
    });
  });
});
