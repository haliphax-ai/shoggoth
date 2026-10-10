/**
 * Phase 4 RED tests: turn event plumbing for the status bar (tool-loop level).
 *
 * `onToolCallEvent` must fire "start" then "end" around executor.execute for calls
 * that proceed to execution (never for policy-denied, validation-skipped, or
 * HITL-queued dispatches). These tests drive `runToolLoop` directly, reusing the
 * same fakes as the existing tool-loop tests.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { runToolLoop, type ModelClient, type ToolCallEvent } from "../../src/sessions/tool-loop";
import { DEFAULT_HITL_CONFIG } from "@shoggoth/shared";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-loop-ev-"));
  const dbPath = join(dir, "l.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("runToolLoop — turn tool-call events", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    createSessionStore(db).create({ id: "sess", workspacePath: "/w" });
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  it("fires start then end around each executed call across hops with runtimeMs on end", async () => {
    const events: ToolCallEvent[] = [];
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return { content: null, toolCalls: [{ id: "c1", name: "read", argsJson: "{}" }] };
        }
        if (step === 2) {
          return { content: null, toolCalls: [{ id: "c2", name: "write", argsJson: "{}" }] };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-ev",
      principalId: "agent:sess",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }, { name: "write" }],
      executor: {
        execute: async () => {
          await new Promise((r) => setTimeout(r, 2));
          return { resultJson: "{}" };
        },
      },
      toolRuns,
      onToolCallEvent: (ev) => events.push(ev),
    });

    // Two executed calls → start/end per call, in order, with runtimeMs only on end.
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((e) => e.phase),
      ["start", "end", "start", "end"],
    );
    assert.deepEqual(
      events.map((e) => e.name),
      ["read", "read", "write", "write"],
    );
    assert.ok(events.every((e) => typeof e.argsJson === "string"));
    assert.equal(events[0]!.runtimeMs, undefined);
    for (const endEv of [events[1]!, events[3]!]) {
      assert.ok(typeof endEv.runtimeMs === "number", "end event should carry runtimeMs");
      assert.ok(endEv.runtimeMs! >= 0);
    }
  });

  it("emits no events for a policy-denied dispatch; only the executed call has events", async () => {
    const events: ToolCallEvent[] = [];
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "d1", name: "builtin-exec", argsJson: "{}" }],
          };
        }
        if (step === 2) {
          return { content: null, toolCalls: [{ id: "c1", name: "read", argsJson: "{}" }] };
        }
        return { content: "end", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-deny-ev",
      principalId: "agent:sess",
      policy: {
        check: ({ toolName }) =>
          toolName === "builtin-exec" ? { allow: false, reason: "blocked" } : { allow: true },
      },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-exec" }, { name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
      onToolCallEvent: (ev) => events.push(ev),
    });

    // The denied call must never surface; the executed read call has start/end.
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.name === "read"));
    assert.deepEqual(
      events.map((e) => e.phase),
      ["start", "end"],
    );
  });

  it("emits no events for a validation-skipped dispatch; only the executed call has events", async () => {
    const events: ToolCallEvent[] = [];
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "v1", name: "builtin-write", argsJson: "{}" }],
          };
        }
        if (step === 2) {
          return { content: null, toolCalls: [{ id: "c1", name: "read", argsJson: "{}" }] };
        }
        return { content: "end", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-valid-ev",
      principalId: "agent:sess",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      // builtin-write requires `path`/`content`; the model emits "{}" → args validation fails.
      tools: [
        {
          name: "builtin-write",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        { name: "read" },
      ],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
      onToolCallEvent: (ev) => events.push(ev),
    });

    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.name === "read"));
    assert.deepEqual(
      events.map((e) => e.phase),
      ["start", "end"],
    );
  });

  it("emits no events for a HITL-denied dispatch; only the executed call has events", async () => {
    const events: ToolCallEvent[] = [];
    let step = 0;
    let pendSeq = 0;
    const stack = createHitlPendingResolutionStack(db);
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "h1", name: "builtin-exec", argsJson: "{}" }],
          };
        }
        if (step === 2) {
          return { content: null, toolCalls: [{ id: "c1", name: "read", argsJson: "{}" }] };
        }
        return { content: "end", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-hitl-deny-ev",
      principalId: "agent:sess",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-exec" }, { name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
      onToolCallEvent: (ev) => events.push(ev),
      hitl: {
        config: {
          ...DEFAULT_HITL_CONFIG,
          toolRisk: { ...DEFAULT_HITL_CONFIG.toolRisk, read: "safe" },
        },
        bypassUpTo: "safe",
        pending: stack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => `pend-deny-ev-${++pendSeq}`,
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

    // Queued-but-denied never executes → no start/end. Only the read call has events.
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.name === "read"));
    assert.deepEqual(
      events.map((e) => e.phase),
      ["start", "end"],
    );
  });

  it("emits no start/end while a HITL approval is queued, then start/end on execution after approval", async () => {
    const events: ToolCallEvent[] = [];
    const order: string[] = [];
    let toolEventsAtQueue = -1;
    let step = 0;
    const stack = createHitlPendingResolutionStack(db);
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "w1", name: "builtin-write", argsJson: "{}" }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-hitl-approve-ev",
      principalId: "agent:sess",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-write" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
      onToolCallEvent: (ev) => {
        order.push(ev.phase);
        events.push(ev);
      },
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "safe",
        pending: stack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-approve-ev",
        waitForHitlResolution: stack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queueMicrotask(() => {
              stack.pending.approve(row.id, "test-op");
            });
          },
        },
        afterHitlQueued: () => {
          toolEventsAtQueue = events.length;
          order.push("queued");
        },
      },
    });

    // The queued marker lands before any tool event; execution then emits start/end.
    assert.equal(toolEventsAtQueue, 0, "no tool events while approval is queued");
    assert.deepEqual(order, ["queued", "start", "end"]);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.phase),
      ["start", "end"],
    );
    assert.ok(events.every((e) => e.name === "builtin-write"));
  });
});
