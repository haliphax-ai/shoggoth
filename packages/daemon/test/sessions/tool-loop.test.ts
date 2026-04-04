import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore, getSessionContextSegmentId } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import {
  runToolLoop,
  TurnAbortedError,
  ToolCallTimeoutError,
  type ModelClient,
  type ToolExecutor,
} from "../../src/sessions/tool-loop";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPendingActionsStore } from "../../src/hitl/pending-actions-store";
import { DEFAULT_HITL_CONFIG } from "@shoggoth/shared";
import type { ChatContentPart } from "@shoggoth/models";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-loop-"));
  const dbPath = join(dir, "l.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("runToolLoop", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    createSessionStore(db).create({ id: "sess", workspacePath: "/w" });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("invokes executor and audit when policy allows", async () => {
    const audit = vi.fn((_e: unknown) => {});
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "read", argsJson: "{}" }],
          };
        }
        return { content: "ok", toolCalls: [] };
      },
    };
    const executor: ToolExecutor = { execute: exec };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-a",
      principalId: "agent:sess",
      policy: {
        check: () => ({ allow: true }),
      },
      audit: { record: audit },
      model,
      tools: [{ name: "read" }],
      executor,
      toolRuns,
    });
    assert.equal(exec.mock.calls.length, 1);
    assert.ok(audit.mock.calls.length >= 2);
    const row = db
      .prepare(`SELECT status FROM tool_runs WHERE id = 'run-a'`)
      .get() as { status: string };
    assert.equal(row.status, "completed");
  });

  it("feeds policy denial back to model and completes", async () => {
    const pushed: { toolCallId: string; content: string }[] = [];
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-exec", argsJson: "{}" }],
          };
        }
        return { content: "denied", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-deny",
      principalId: "agent:sess",
      policy: {
        check: () => ({ allow: false, reason: "blocked" }),
      },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-exec" }],
      executor: { execute: exec },
      toolRuns,
    });
    // Executor should never have been called
    assert.equal(exec.mock.calls.length, 0);
    // Model should have received the denial via pushToolMessage
    assert.equal(pushed.length, 1);
    assert.ok(pushed[0]!.content.includes("policy_denied"));
    // Run should complete (model recovered on second hop)
    const row = db
      .prepare(`SELECT status FROM tool_runs WHERE id = 'run-deny'`)
      .get() as { status: string };
    assert.equal(row.status, "completed");
  });

  it("queues HITL pending and skips execute when operator denies", async () => {
    const audit = vi.fn((_e: unknown) => {});
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    const stack = createHitlPendingResolutionStack(db);
    let idSeq = 0;
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "h1", name: "builtin-exec", argsJson: '{"x":1}' }],
          };
        }
        return { content: "ok after hitl", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-hitl",
      principalId: "agent:sess",
      policy: { check: () => ({ allow: true }) },
      audit: { record: audit },
      model,
      tools: [{ name: "builtin-exec" }],
      executor: { execute: exec },
      toolRuns,
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "safe",
        pending: stack.pending,
        clock: { nowMs: () => 1_700_000_000_000 },
        newPendingId: () => `pend-${++idSeq}`,
        waitForHitlResolution: stack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queueMicrotask(() => {
              stack.pending.deny(row.id, "test-op");
            });
          },
        },
      },
    });
    assert.equal(exec.mock.calls.length, 0);
    const row = stack.pending.getById("pend-1");
    assert.ok(row);
    assert.equal(row!.status, "denied");
    assert.equal(row!.toolName, "builtin-exec");
    const run = db
      .prepare(`SELECT status, failure_reason FROM tool_runs WHERE id = 'run-hitl'`)
      .get() as { status: string; failure_reason: string | null };
    assert.equal(run.status, "completed");
    assert.ok(audit.mock.calls.some((c) => String(JSON.stringify(c)).includes("hitl_queued")));
  });

  it("does not queue HITL when role bypass covers tool risk", async () => {
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    const pending = createPendingActionsStore(db);
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "h2", name: "builtin-exec", argsJson: "{}" }],
          };
        }
        return { content: "ok", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    const config = {
      ...DEFAULT_HITL_CONFIG,
    };
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-bypass",
      principalId: "op",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-exec" }],
      executor: { execute: exec },
      toolRuns,
      hitl: {
        config,
        bypassUpTo: "critical",
        pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "should-not-use",
        waitForHitlResolution: () =>
          new Promise(() => {
            /* never used when bypass applies */
          }),
      },
    });
    assert.equal(exec.mock.calls.length, 1);
    assert.equal(pending.listPendingForSession("sess").length, 0);
  });

  it("skips HITL enqueue when autoApprove.shouldAutoApprove is true", async () => {
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    const pending = createPendingActionsStore(db);
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "h3", name: "builtin-exec", argsJson: "{}" }],
          };
        }
        return { content: "ok", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-auto-hitl",
      principalId: "op",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-exec" }],
      executor: { execute: exec },
      toolRuns,
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "safe",
        pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "no-queue",
        waitForHitlResolution: () =>
          new Promise(() => {
            /* unused */
          }),
        autoApprove: {
          enableSessionTool: () => {},
          enableAgentTool: () => {},
          shouldAutoApprove: () => true,
        },
      },
    });
    assert.equal(exec.mock.calls.length, 1);
    assert.equal(pending.listPendingForSession("sess").length, 0);
  });

  it("appends transcript for tool result when transcript store provided", async () => {
    const tr = createTranscriptStore(db);
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "t1", name: "read", argsJson: "{}" }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-tr",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: '{"x":1}' }) },
      toolRuns,
      transcript: tr,
      contextSegmentId: seg,
    });
    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 20 });
    const toolMsgs = page.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 1);
    assert.ok(String(toolMsgs[0]!.metadata).includes("read") || toolMsgs[0]!.toolCallId === "t1");
  });

  it("throws TurnAbortedError when turnAbortSignal fires before the next model hop", async () => {
    const ac = new AbortController();
    let completeCalls = 0;
    const model: ModelClient = {
      async complete() {
        completeCalls += 1;
        if (completeCalls === 1) {
          return {
            content: null,
            toolCalls: [{ id: "ab1", name: "read", argsJson: "{}" }],
          };
        }
        return { content: "late", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await assert.rejects(
      runToolLoop({
        db,
        sessionId: "sess",
        runId: "run-abort",
        principalId: "p",
        policy: { check: () => ({ allow: true }) },
        audit: { record: () => {} },
        model,
        tools: [{ name: "read" }],
        turnAbortSignal: ac.signal,
        executor: {
          async execute() {
            ac.abort();
            return { resultJson: "{}" };
          },
        },
        toolRuns,
      }),
      (err: unknown) => err instanceof TurnAbortedError,
    );
    assert.equal(completeCalls, 1);
  });
  it("injects timeout error when tool call exceeds toolCallTimeoutMs", async () => {
    const pushed: { toolCallId: string; content: string }[] = [];
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "t1", name: "slow", argsJson: "{}" }],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const toolRuns = createToolRunStore(db);
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-timeout",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "slow" }],
      executor: {
        execute: () => new Promise((resolve) => setTimeout(() => resolve({ resultJson: '"late"' }), 500)),
      },
      toolRuns,
      transcript: tr,
      contextSegmentId: seg,
      toolCallTimeoutMs: 50,
    });
    // The model should have received a timeout error message
    assert.equal(pushed.length, 1);
    const parsed = JSON.parse(pushed[0]!.content);
    assert.equal(parsed.error, "tool_call_timeout");
    assert.equal(parsed.tool, "slow");
    assert.equal(parsed.timeoutMs, 50);
    // Transcript should contain the timeout tool message
    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 20 });
    const toolMsgs = page.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 1);
    assert.ok(toolMsgs[0]!.content!.includes("tool_call_timeout"));
    // Run should still complete (model recovered)
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-timeout'`).get() as { status: string };
    assert.equal(row.status, "completed");
  });

  it("does not timeout when toolCallTimeoutMs is not set", async () => {
    const exec = vi.fn(async () => ({ resultJson: '{"ok":true}' }));
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "nt1", name: "fast", argsJson: "{}" }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-no-timeout",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "fast" }],
      executor: { execute: exec },
      toolRuns,
    });
    assert.equal(exec.mock.calls.length, 1);
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-no-timeout'`).get() as { status: string };
    assert.equal(row.status, "completed");
  });

  it("stores JSON-serialized contentParts as tool message content when executor returns contentParts", async () => {
    const tr = createTranscriptStore(db);
    const pushed: { toolCallId: string; content: string }[] = [];
    const contentParts: ChatContentPart[] = [
      { type: "text", text: "Here is the image" },
      { type: "image", mediaType: "image/png", base64: "iVBORw0KGgo=" },
    ];
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "img1", name: "read", argsJson: '{"path":"test.png"}' }],
          };
        }
        return { content: "I see the image", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const toolRuns = createToolRunStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-img",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: {
        execute: async () => ({
          resultJson: '{"path":"test.png"}',
          contentParts,
        }),
      },
      toolRuns,
      transcript: tr,
      contextSegmentId: seg,
    });

    // Verify the model received the JSON-serialized contentParts
    assert.equal(pushed.length, 1);
    const pushedContent = JSON.parse(pushed[0]!.content);
    assert.ok(Array.isArray(pushedContent));
    assert.equal(pushedContent.length, 2);
    assert.equal(pushedContent[0].type, "text");
    assert.equal(pushedContent[0].text, "Here is the image");
    assert.equal(pushedContent[1].type, "image");
    assert.equal(pushedContent[1].mediaType, "image/png");
    assert.equal(pushedContent[1].base64, "iVBORw0KGgo=");

    // Verify the transcript stores the JSON-serialized contentParts
    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 20 });
    const toolMsgs = page.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 1);
    const storedContent = JSON.parse(toolMsgs[0]!.content!);
    assert.ok(Array.isArray(storedContent));
    assert.equal(storedContent.length, 2);
    assert.equal(storedContent[1].type, "image");
    assert.equal(storedContent[1].base64, "iVBORw0KGgo=");

    // Run should complete
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-img'`).get() as { status: string };
    assert.equal(row.status, "completed");
  });

  it("feeds parse error back to model when argsJson is not valid JSON", async () => {
    const pushed: { toolCallId: string; content: string }[] = [];
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "p1", name: "read", argsJson: "{bad json" }],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-parse",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: exec },
      toolRuns,
    });
    assert.equal(exec.mock.calls.length, 0);
    assert.equal(pushed.length, 1);
    const parsed = JSON.parse(pushed[0]!.content);
    assert.equal(parsed.error, "invalid_arguments");
    assert.ok(parsed.message.includes("not valid JSON"));
  });

  it("feeds validation error back to model when args fail schema check", async () => {
    const pushed: { toolCallId: string; content: string }[] = [];
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "v1", name: "read", argsJson: '{"limit": "not-a-number"}' }],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const toolRuns = createToolRunStore(db);
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["path"],
    };
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-validate",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read", inputSchema: schema }],
      executor: { execute: exec },
      toolRuns,
    });
    assert.equal(exec.mock.calls.length, 0);
    assert.equal(pushed.length, 1);
    const parsed = JSON.parse(pushed[0]!.content);
    assert.equal(parsed.error, "invalid_arguments");
    assert.ok(parsed.message.includes("path"));
    assert.ok(parsed.message.includes("limit"));
  });

  it("executes normally when args pass schema validation", async () => {
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "ok1", name: "read", argsJson: '{"path":"/tmp/foo","limit":10}' }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["path"],
    };
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-valid",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read", inputSchema: schema }],
      executor: { execute: exec },
      toolRuns,
    });
    assert.equal(exec.mock.calls.length, 1);
  });
});
