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
  type ModelClient,
  type ToolExecutor,
} from "../../src/sessions/tool-loop";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPendingActionsStore } from "../../src/hitl/pending-actions-store";
import { DEFAULT_HITL_CONFIG } from "@shoggoth/shared";

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

  it("marks run failed and stops when policy denies", async () => {
    const model: ModelClient = {
      async complete() {
        return {
          content: null,
          toolCalls: [{ id: "c1", name: "builtin.exec", argsJson: "{}" }],
        };
      },
    };
    const toolRuns = createToolRunStore(db);
    await assert.rejects(
      () =>
        runToolLoop({
          db,
          sessionId: "sess",
          runId: "run-deny",
          principalId: "agent:sess",
          policy: {
            check: () => ({ allow: false, reason: "blocked" }),
          },
          audit: { record: () => {} },
          model,
          tools: [{ name: "builtin.exec" }],
          executor: { execute: async () => ({ resultJson: "{}" }) },
          toolRuns,
        }),
      /blocked/,
    );
    const row = db
      .prepare(`SELECT status, failure_reason FROM tool_runs WHERE id = 'run-deny'`)
      .get() as { status: string; failure_reason: string | null };
    assert.equal(row.status, "failed");
    assert.match(row.failure_reason ?? "", /policy/);
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
            toolCalls: [{ id: "h1", name: "builtin.exec", argsJson: '{"x":1}' }],
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
      tools: [{ name: "builtin.exec" }],
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
    assert.equal(row!.toolName, "builtin.exec");
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
            toolCalls: [{ id: "h2", name: "builtin.exec", argsJson: "{}" }],
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
      tools: [{ name: "builtin.exec" }],
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
            toolCalls: [{ id: "h3", name: "builtin.exec", argsJson: "{}" }],
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
      tools: [{ name: "builtin.exec" }],
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
});
