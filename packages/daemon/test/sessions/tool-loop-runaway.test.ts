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

    // Three identical calls trip the breaker; the third still executes, the
    // steer is injected before the next model hop, which then recovers.
    assert.equal(steers.length, 1);
    assert.match(steers[0]!, /runaway/i);
    assert.match(steers[0]!, /same-tool/);
    assert.equal(executor.mock.calls.length, 3);
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

    // Hop 1-2: ok. Hop 3: steer (3rd identical, still executed). Window
    // resets. Hop 4-5: ok. Hop 6: executes, then the cancel verdict stops
    // the loop without a 7th model call.
    assert.equal(completions.length, 6);
    assert.equal(executor.mock.calls.length, 6);
    assert.ok(
      audits.some((a) => a.phase === "runaway_breaker_cancel"),
      "cancel must be recorded in the audit trail",
    );
  });

  it("appends the cancel warning to the transcript so it reaches the caller", async () => {
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

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-cancel-tx",
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
    const warning = page.messages.find(
      (m) =>
        m.role === "assistant" &&
        !m.toolCalls?.length &&
        (m.content ?? "").includes("canceled") &&
        (m.metadata as { runawayBreakerCancel?: boolean } | undefined)?.runawayBreakerCancel ===
          true,
    );
    assert.ok(warning, "cancel warning should be the turn's terminal assistant message");
  });

  it("posts an in-turn banner on cancel via the active turn surface", async () => {
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
    const notices: string[] = [];
    registerActiveTurnSurface("sess", (n) => {
      notices.push(n);
    });

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-cancel-banner",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "same-tool" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns: createToolRunStore(db),
    });

    assert.ok(
      notices.some((n) => n.includes("breaker") && n.includes("same-tool")),
      `expected a cancel banner among ${JSON.stringify(notices)}`,
    );
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
});
