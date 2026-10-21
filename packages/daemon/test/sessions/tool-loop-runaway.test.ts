import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore, getSessionContextSegmentId } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop, type ModelClient } from "../../src/sessions/tool-loop";
import {
  _resetActiveTurnSurfaces,
  registerActiveTurnSurface,
} from "../../src/presentation/active-turn-surface";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-runaway-"));
  const dbPath = join(dir, "s.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

/** Model that emits the same tool call on the first `identicalCalls` hops, then finishes. */
function identicalCallModel(identicalCalls: number, name = "same-tool"): ModelClient {
  let step = 0;
  return {
    async complete() {
      step += 1;
      if (step <= identicalCalls) {
        return {
          content: null,
          toolCalls: [{ id: `c${step}`, name, argsJson: '{"path":"loop.txt"}' }],
        };
      }
      return { content: "recovered", toolCalls: [] };
    },
    pushToolMessage() {},
    pushSteerMessage() {},
  };
}

describe("runToolLoop runaway circuit breaker", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    createSessionStore(db).create({ id: "sess", workspacePath: "/w" });
  });

  afterEach(async () => {
    _resetActiveTurnSurfaces();
    await closeTestDb(db, tmp);
  });

  it("steers the model when an identical call repeats past the threshold", async () => {
    const steers: string[] = [];
    const model = identicalCallModel(3);
    model.pushSteerMessage = (content: string) => {
      steers.push(content);
    };
    const executor = vi.fn(async () => ({ resultJson: "{}" }));

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-steer",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "same-tool" }],
      executor: { execute: executor },
      toolRuns: createToolRunStore(db),
    });

    // Three identical calls trip the breaker; the third is prevented before\n    // execution — only the first two reach the executor — and the steer is\n    // injected before the next model hop, which then recovers.\n    assert.equal(steers.length, 1);\n    assert.match(steers[0]!, /runaway/i);\n    assert.match(steers[0]!, /same-tool/);\n    assert.equal(executor.mock.calls.length, 2);
  });

  it("cancels the turn when the pattern persists after a steer", async () => {
    let step = 0;
    const completions: number[] = [];
    const model: ModelClient = {
      async complete() {
        step += 1;
        completions.push(step);
        return {
          content: null,
          toolCalls: [{ id: `c${step}`, name: "same-tool", argsJson: '{"path":"loop.txt"}' }],
        };
      },
      pushToolMessage() {},
      pushSteerMessage() {},
    };
    const executor = vi.fn(async () => ({ resultJson: "{}" }));
    const audits: Array<Record<string, unknown>> = [];

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-cancel",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e) => {
          audits.push(e as Record<string, unknown>);
        },
      },
      model,
      tools: [{ name: "same-tool" }],
      executor: { execute: executor },
      toolRuns: createToolRunStore(db),
    });

    // Hop 1-2: ok. Hop 3: steer (3rd identical, prevented before execution).
    // Window resets. Hop 4-5: ok. Hop 6: the cancel verdict also trips
    // BEFORE execution, so only 4 calls reach the executor (hops 1, 2, 4,
    // 5); the loop stops without a 7th model call (completions stay at 6).
    assert.equal(completions.length, 6);
    assert.equal(executor.mock.calls.length, 4);
    assert.ok(
      audits.some((a) => a.phase === "runaway_breaker_cancel"),
      "cancel must be recorded in the audit trail",
    );
  });

  it("delivers the cancel notice exactly once via the surface and never via the transcript", async () => {
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        return {
          content: null,
          toolCalls: [{ id: `c${step}`, name: "same-tool", argsJson: '{"path":"loop.txt"}' }],
        };
      },
      pushToolMessage() {},
      pushSteerMessage() {},
    };
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    const notices: string[] = [];
    registerActiveTurnSurface("sess", (n) => {
      notices.push(n);
    });

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-cancel-delivery",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "same-tool" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns: createToolRunStore(db),
      transcript: tr,
      contextSegmentId: seg,
    });

    const cancelNotices = notices.filter((n) => n.includes("canceled"));
    assert.equal(
      cancelNotices.length,
      1,
      `expected exactly one cancel notice among ${JSON.stringify(notices)}`,
    );
    assert.ok(cancelNotices[0]!.includes("same-tool"));

    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 200 });
    const leaked = page.messages.find(
      (m) =>
        m.role === "assistant" &&
        ((m.content ?? "").includes("canceled") ||
          (m.metadata as { runawayBreakerCancel?: boolean } | undefined)?.runawayBreakerCancel ===
            true),
    );
    assert.ok(!leaked, "cancel notice must not be appended to the transcript");
  });

  it("leaves varied tool call patterns alone", async () => {
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step <= 5) {
          return {
            content: null,
            toolCalls: [{ id: `c${step}`, name: "t", argsJson: `{"n":${step}}` }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
      pushSteerMessage() {},
    };
    const executor = vi.fn(async () => ({ resultJson: "{}" }));
    const audits: Array<Record<string, unknown>> = [];

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-varied",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e) => {
          audits.push(e as Record<string, unknown>);
        },
      },
      model,
      tools: [{ name: "t" }],
      executor: { execute: executor },
      toolRuns: createToolRunStore(db),
    });

    assert.equal(executor.mock.calls.length, 5);
    assert.ok(!audits.some((a) => String(a.phase ?? "").startsWith("runaway")));
  });

  it("steers when hop prose accumulates past the budget without concluding", async () => {
    const steers: string[] = [];
    let step = 0;
    const bigProse = "lorem ipsum ".repeat(50); // 600 chars per hop
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step <= 2) {
          // Prose-heavy hops that keep the loop spinning with a tool call.
          return {
            content: bigProse,
            toolCalls: [{ id: `c${step}`, name: "t", argsJson: `{"n":${step}}` }],
          };
        }
        return { content: "concluded", toolCalls: [] };
      },
      pushToolMessage() {},
      pushSteerMessage() {},
    };
    model.pushSteerMessage = (content: string) => {
      steers.push(content);
    };
    const audits: Array<Record<string, unknown>> = [];

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-prose-steer",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e) => {
          audits.push(e as Record<string, unknown>);
        },
      },
      model,
      tools: [{ name: "t" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns: createToolRunStore(db),
      runawayBreaker: { proseCharLimit: 1000 },
    });

    // Hop 1: 600 chars — ok. Hop 2: 1200 — trips the steer; the hop's tool
    // call still executes. Hop 3 concludes normally.
    assert.equal(steers.length, 1);
    assert.match(steers[0]!, /prose/i);
    assert.ok(
      audits.some(
        (a) =>
          a.phase === "runaway_breaker_steer" &&
          (a.trigger as { kind?: string } | undefined)?.kind === "excessive_prose",
      ),
      "prose steer must be audited with an excessive_prose trigger",
    );
  });

  it("cancels the turn when the prose budget is blown again after a steer", async () => {
    let step = 0;
    const bigProse = "lorem ipsum ".repeat(50); // 600 chars per hop
    const completions: number[] = [];
    const model: ModelClient = {
      async complete() {
        step += 1;
        completions.push(step);
        return {
          content: bigProse,
          toolCalls: [{ id: `c${step}`, name: "t", argsJson: `{"n":${step}}` }],
        };
      },
      pushToolMessage() {},
      pushSteerMessage() {},
    };
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    const audits: Array<Record<string, unknown>> = [];

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-prose-cancel",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e) => {
          audits.push(e as Record<string, unknown>);
        },
      },
      model,
      tools: [{ name: "t" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns: createToolRunStore(db),
      transcript: tr,
      contextSegmentId: seg,
      runawayBreaker: { proseCharLimit: 1000 },
    });

    // Hop 1: 600 — ok. Hop 2: 1200 — steer. Hop 3: 600 — ok (budget
    // reset). Hop 4: 1200 — cancel; no 5th model call.
    assert.equal(completions.length, 4);
    assert.ok(
      audits.some(
        (a) =>
          a.phase === "runaway_breaker_cancel" &&
          (a.trigger as { kind?: string } | undefined)?.kind === "excessive_prose",
      ),
      "prose cancel must be audited with an excessive_prose trigger",
    );

    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 200 });
    const leaked = page.messages.find(
      (m) =>
        m.role === "assistant" &&
        (m.metadata as { runawayBreakerCancel?: boolean } | undefined)?.runawayBreakerCancel ===
          true,
    );
    assert.ok(!leaked, "prose cancel notice must not be appended to the transcript");
  });

  it("never charges the terminal response against the prose budget", async () => {
    let step = 0;
    const hugeTerminal = "x".repeat(5000);
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: "working... ",
            toolCalls: [{ id: "c1", name: "t", argsJson: "{}" }],
          };
        }
        // The terminal prose IS the deliverable — must not trip.
        return { content: hugeTerminal, toolCalls: [] };
      },
      pushToolMessage() {},
      pushSteerMessage() {},
    };
    const audits: Array<Record<string, unknown>> = [];

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-prose-terminal",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e) => {
          audits.push(e as Record<string, unknown>);
        },
      },
      model,
      tools: [{ name: "t" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns: createToolRunStore(db),
      runawayBreaker: { proseCharLimit: 1000 },
    });

    assert.ok(!audits.some((a) => String(a.phase ?? "").startsWith("runaway")));
  });

  it("persists the steer to the transcript as a user message", async () => {
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step <= 3) {
          return {
            content: null,
            toolCalls: [{ id: `c${step}`, name: "same-tool", argsJson: '{"path":"loop.txt"}' }],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage() {},
      pushSteerMessage() {},
    };
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-steer-tx",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "same-tool" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns: createToolRunStore(db),
      transcript: tr,
      contextSegmentId: seg,
    });

    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 100 });
    const steerRow = page.messages.find(
      (m) =>
        m.role === "user" &&
        (m.metadata as { runawayBreakerSteer?: boolean } | undefined)?.runawayBreakerSteer === true,
    );
    assert.ok(steerRow, "steer message should be persisted in the transcript");
  });

  it("discards the rest of the batch on a steer, answers every prevented id, and steers the next hop", async () => {
    const events: string[] = [];
    const pushed: Array<{ toolCallId: string; content: string }> = [];
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    let hop = 0;
    const model: ModelClient = {
      async complete() {
        hop += 1;
        events.push(`complete:${hop}`);
        if (hop === 1) {
          // Four identical calls: the third trips the steer before executing;
          // the fourth is discarded with the batch.
          return {
            content: null,
            toolCalls: [
              { id: "a1", name: "t", argsJson: '{"n":1}' },
              { id: "a2", name: "t", argsJson: '{"n":1}' },
              { id: "a3", name: "t", argsJson: '{"n":1}' },
              { id: "a4", name: "t", argsJson: '{"n":1}' },
            ],
          };
        }
        if (hop === 2) {
          // The turn continues after the steer: this hop must run, having
          // received the steer message before any further tool execution.
          return {
            content: null,
            toolCalls: [{ id: "b1", name: "t", argsJson: '{"n":99}' }],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(input) {
        pushed.push(input);
      },
      pushSteerMessage() {
        events.push("steer");
      },
    };
    const executor = vi.fn(async (input: { toolCallId: string }) => {
      events.push(`exec:${input.toolCallId}`);
      return { resultJson: "{}" };
    });

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-midbatch",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "t" }],
      executor: { execute: executor },
      toolRuns: createToolRunStore(db),
      transcript: tr,
      contextSegmentId: seg,
      onToolCallEvent: (ev) => {
        if (ev.phase === "start") events.push(`start:${ev.argsJson}`);
      },
    });

    // The tripping call (a3) and the discarded remainder (a4) never reach the
    // executor; no start/end tool-call events fire for them either.
    assert.ok(
      !events.some((e) => e === "exec:a3" || e === "exec:a4"),
      "prevented calls must not execute",
    );
    assert.ok(events.includes("exec:a1") && events.includes("exec:a2"));
    assert.ok(events.includes('start:{"n":1}'), "executed calls emit start events");
    const steerIdx = events.indexOf("steer");
    const hop2Idx = events.indexOf("complete:2");
    const b1Idx = events.indexOf("exec:b1");
    assert.ok(
      steerIdx < hop2Idx && hop2Idx < b1Idx,
      "steer precedes the next hop, which precedes its tool execution",
    );
    assert.equal(executor.mock.calls.length, 3, "a1, a2, and b1 execute; a3 and a4 are prevented");

    // Synthetic results answer every prevented tool_call id.
    const blocked = pushed.find((p) => p.toolCallId === "a3");
    const skipped = pushed.find((p) => p.toolCallId === "a4");
    assert.ok(blocked && blocked.content.includes("runaway_breaker_blocked"));
    assert.ok(skipped && skipped.content.includes("runaway_breaker_skipped"));
    assert.equal(pushed.filter((p) => p.toolCallId === "a1" || p.toolCallId === "a2").length, 2);

    // And they are persisted as tool rows so the next hop sees a consistent transcript.
    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 200 });
    for (const id of ["a3", "a4"]) {
      const row = page.messages.find((m) => m.role === "tool" && m.toolCallId === id);
      assert.ok(row, `synthetic tool result for ${id} must be in the transcript`);
    }
  });

  it("returns canceledBy runaway when the breaker cancels the turn", async () => {
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        return {
          content: null,
          toolCalls: [{ id: `c${step}`, name: "same-tool", argsJson: '{"path":"loop.txt"}' }],
        };
      },
      pushToolMessage() {},
      pushSteerMessage() {},
    };

    const result = await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-canceled-by",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "same-tool" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns: createToolRunStore(db),
      runawayBreaker: { maxDuplicates: 0 },
    });

    assert.equal(result?.canceledBy, "runaway");
  });
});
