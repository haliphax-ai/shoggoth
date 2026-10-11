import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import type { TaskList, TaskState, TaskDef, DependencyGraph } from "../src/types.js";
import type { MessageAdapter } from "../src/message-adapter.js";
import { StatusManager } from "../src/status-manager.js";

// --- Helpers ---

function makeDef(id: number, prompt: string): TaskDef {
  return {
    kind: "agent",
    id,
    prompt,
    failureBehavior: "continue",
    failureNotification: "silent",
  };
}

function makeTask(
  id: number,
  prompt: string,
  status: TaskState["status"],
  opts: Partial<Pick<TaskState, "startedAt" | "completedAt" | "error">> = {},
): TaskState {
  return { taskDef: makeDef(id, prompt), status, ...opts };
}

function makeWorkflow(name: string, tasks: TaskState[], graph: DependencyGraph): TaskList {
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
  pinned: string[] = [];
  editFailureReason: "not_found" | "unsupported" | "transient" | null = null;
  private nextId = 1;

  async postMessage(content: string): Promise<{ messageId: string }> {
    const messageId = `msg-${this.nextId++}`;
    this.posted.push({ content, messageId });
    return { messageId };
  }

  async editMessage(
    messageId: string,
    content: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "unsupported" | "transient" }> {
    if (this.editFailureReason) return { ok: false, reason: this.editFailureReason };
    this.edited.push({ messageId, content });
    return { ok: true };
  }

  async pinMessage(messageId: string): Promise<void> {
    this.pinned.push(messageId);
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
      const wf = makeWorkflow(
        "test-wf",
        [makeTask(1, "First", "pending"), makeTask(2, "Second", "pending")],
        graph,
      );

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

    it("reposts when the message is gone (not_found)", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);
      assert.equal(adapter.posted.length, 1);

      adapter.editFailureReason = "not_found";
      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = Date.now();
      await manager.updateStatus(wf);

      // The message is genuinely gone — repost instead of editing
      assert.equal(adapter.posted.length, 2);
      assert.equal(adapter.edited.length, 0);
    });

    it("continues editing after the message was recreated by a repost", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);
      adapter.editFailureReason = "not_found";

      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = Date.now();
      await manager.updateStatus(wf);

      // Once the message exists again, edits resume against the new message ID
      adapter.editFailureReason = null;
      await manager.updateStatus(wf);

      // 1 initial + 1 repost + 1 edit (against msg-2, the reposted message)
      assert.equal(adapter.posted.length, 2);
      assert.equal(adapter.edited.length, 1);
      assert.equal(adapter.edited[0].messageId, "msg-2");
    });

    it("does NOT repost on transient edit failures (rate limit, 5xx, network)", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);
      assert.equal(adapter.posted.length, 1);

      adapter.editFailureReason = "transient";
      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = Date.now();
      await manager.updateStatus(wf);

      // The message still exists — no repost, no orphaned duplicate
      assert.equal(adapter.posted.length, 1);
      assert.equal(adapter.edited.length, 0);

      // Next tick retries the edit in place once the transient clears
      adapter.editFailureReason = null;
      await manager.updateStatus(wf);
      assert.equal(adapter.posted.length, 1);
      assert.equal(adapter.edited.length, 1);
      assert.equal(adapter.edited[0].messageId, "msg-1");
    });

    it("reposts when the platform does not support edits (unsupported)", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);
      adapter.editFailureReason = "unsupported";
      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = Date.now();
      await manager.updateStatus(wf);

      assert.equal(adapter.posted.length, 2);
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
      const wf = makeWorkflow(
        "wf",
        [
          makeTask(1, "A", "done", { startedAt: 0, completedAt: 60_000 }),
          makeTask(2, "B", "done", { startedAt: 0, completedAt: 120_000 }),
        ],
        graph,
      );
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
      const wf = makeWorkflow(
        "wf",
        [
          makeTask(1, "Good", "done", { startedAt: 0, completedAt: 60_000 }),
          makeTask(2, "Bad", "failed", { startedAt: 0, completedAt: 3_000 }),
        ],
        graph,
      );
      wf.createdAt = 0;

      await manager.postSummary(wf);

      assert.ok(adapter.posted[0].content.includes("❌ **Failed:** 1/2"));
      assert.ok(adapter.posted[0].content.includes("- 2 - Bad (3s)"));
    });
  });

  describe("pinning", () => {
    it("pins the status post on creation by default when the adapter supports it", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);

      assert.deepEqual(adapter.pinned, ["msg-1"]);
    });

    it("re-pins the reposted message when edit fails", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);

      await manager.postInitialStatus(wf);
      assert.deepEqual(adapter.pinned, ["msg-1"]);

      adapter.editFailureReason = "not_found";
      wf.tasks[0].status = "in_progress";
      wf.tasks[0].startedAt = Date.now();
      await manager.updateStatus(wf);

      assert.deepEqual(adapter.pinned, ["msg-1", "msg-2"]);
    });

    it("does not pin when pinStatusPost is false", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);
      const noPin = new StatusManager(adapter, { pinStatusPost: false });

      await noPin.postInitialStatus(wf);

      assert.deepEqual(adapter.pinned, []);
    });

    it("does not pin when the adapter has no pinMessage support", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);
      const posts: Array<{ content: string; messageId: string }> = [];
      const noPinAdapter: MessageAdapter = {
        async postMessage(content: string): Promise<{ messageId: string }> {
          const messageId = "plain-msg-1";
          posts.push({ content, messageId });
          return { messageId };
        },
        async editMessage() {
          return { ok: true as const };
        },
        // no pinMessage — platform without pinning support
      };
      const m = new StatusManager(noPinAdapter);

      await m.postInitialStatus(wf);

      assert.equal(posts.length, 1);
    });

    it("pin failure does not fail the status flow", async () => {
      const graph: DependencyGraph = new Map([[1, new Set()]]);
      const wf = makeWorkflow("wf", [makeTask(1, "Task", "pending")], graph);
      const failing = new MockMessageAdapter();
      failing.pinMessage = async () => {
        throw new Error("permission denied");
      };
      const m = new StatusManager(failing);

      await m.postInitialStatus(wf);

      assert.equal(failing.posted.length, 1);
    });
  });
});
