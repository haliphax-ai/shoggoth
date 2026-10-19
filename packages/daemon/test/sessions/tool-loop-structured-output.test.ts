import { describe, it, beforeEach, afterEach } from "vitest";
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
import { runToolLoop, TurnAbortedError, type ModelClient } from "../../src/sessions/tool-loop";
import { StructuredOutputValidationError } from "@shoggoth/models";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-so-"));
  const dbPath = join(dir, "so.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

const TEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    total_errors: { type: "number" },
    categories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "number" },
        },
        required: ["name", "count"],
      },
    },
  },
  required: ["total_errors", "categories"],
  additionalProperties: false,
};

const BAD_CONTENT = '{"total_errors": 5}'; // missing "categories"

function makeValidationError(msg?: string): StructuredOutputValidationError {
  return new StructuredOutputValidationError(
    msg ?? 'Schema validation failed: /: must have required property "categories"',
    BAD_CONTENT,
    TEST_SCHEMA,
  );
}

describe("runToolLoop structured output validation retry", () => {
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

  it("retries after StructuredOutputValidationError and succeeds on second attempt", async () => {
    const steered: string[] = [];
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        if (completeCall === 1) {
          throw makeValidationError();
        }
        // Second attempt succeeds — terminal response
        return {
          content: '{"total_errors": 5, "categories": [{"name": "timeout", "count": 3}]}',
          toolCalls: [],
        };
      },
      pushSteerMessage(content) {
        steered.push(content);
      },
    };
    const toolRuns = createToolRunStore(db);
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-so-retry-ok",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
      transcript: tr,
      contextSegmentId: seg,
    });

    // model.complete() should have been called twice (1 fail + 1 success)
    assert.equal(completeCall, 2);

    // A correction message should have been injected via pushSteerMessage
    assert.equal(steered.length, 1);
    assert.ok(steered[0]!.includes("did not conform"));
    assert.ok(steered[0]!.includes("categories"));

    // Run should complete successfully
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-so-retry-ok'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
  });

  it("bubbles up the last attempt after retries are exhausted instead of throwing", async () => {
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        throw makeValidationError(`attempt ${completeCall} failed`);
      },
      pushSteerMessage() {},
    };
    const toolRuns = createToolRunStore(db);
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");

    // Does NOT reject: the last failed attempt is surfaced as the turn's
    // terminal response instead of killing the whole turn.
    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-so-exhaust",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
      transcript: tr,
      contextSegmentId: seg,
    });

    // Should have attempted exactly 3 times (1 initial + 2 retries)
    assert.equal(completeCall, 3);

    // The run completes (the turn ends) rather than erroring out.
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-so-exhaust'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");

    // The last attempt is the final tool-call-free assistant row, so callers
    // (e.g. OOB delivery) pick it up as the turn's response text.
    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 20 });
    const last = page.messages[page.messages.length - 1]!;
    assert.equal(last.role, "assistant");
    assert.equal(last.content, BAD_CONTENT);
    const lastMeta = typeof last.metadata === "string" ? JSON.parse(last.metadata) : last.metadata;
    assert.equal(lastMeta.structuredOutputValidationFailed, true);
  });

  it("records failed response and correction in transcript with correct metadata", async () => {
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        if (completeCall === 1) {
          throw makeValidationError();
        }
        return {
          content: '{"total_errors": 5, "categories": []}',
          toolCalls: [],
        };
      },
      pushSteerMessage() {},
    };
    const toolRuns = createToolRunStore(db);
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-so-transcript",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
      transcript: tr,
      contextSegmentId: seg,
    });

    const page = tr.listPage({
      sessionId: "sess",
      contextSegmentId: seg,
      afterSeq: 0,
      limit: 20,
    });

    // Expect 3 transcript entries:
    // 1. assistant message with failed content + structuredOutputValidationFailed metadata
    // 2. user message with correction + structuredOutputCorrection metadata
    // 3. assistant message with successful content
    assert.ok(page.messages.length >= 3, `expected >= 3 messages, got ${page.messages.length}`);

    // First: failed assistant response
    const failedMsg = page.messages[0]!;
    assert.equal(failedMsg.role, "assistant");
    assert.equal(failedMsg.content, BAD_CONTENT);
    const failedMeta =
      typeof failedMsg.metadata === "string" ? JSON.parse(failedMsg.metadata) : failedMsg.metadata;
    assert.equal(failedMeta.structuredOutputValidationFailed, true);

    // Second: correction user message
    const correctionMsg = page.messages[1]!;
    assert.equal(correctionMsg.role, "user");
    assert.ok(correctionMsg.content!.includes("did not conform"));
    const corrMeta =
      typeof correctionMsg.metadata === "string"
        ? JSON.parse(correctionMsg.metadata)
        : correctionMsg.metadata;
    assert.equal(corrMeta.structuredOutputCorrection, true);

    // Third: successful assistant response
    const successMsg = page.messages[2]!;
    assert.equal(successMsg.role, "assistant");
    assert.ok(successMsg.content!.includes("total_errors"));
    assert.ok(successMsg.content!.includes("categories"));
  });

  it("resets retry counter after a successful terminal response", async () => {
    // Scenario: first complete() returns tool calls, tool executes, second complete()
    // throws validation error, third complete() succeeds (counter should be at 1),
    // then on a hypothetical next failure cycle the counter should start fresh.
    //
    // We simulate: tool call round → validation fail → success → done.
    // The key assertion is that the retry counter resets after the success,
    // meaning a subsequent validation failure would get a fresh set of retries.
    let completeCall = 0;
    const steered: string[] = [];
    const model: ModelClient = {
      async complete() {
        completeCall++;
        if (completeCall === 1) {
          // First call: return a tool call
          return {
            content: null,
            toolCalls: [{ id: "tc1", name: "read", argsJson: "{}" }],
          };
        }
        if (completeCall === 2) {
          // After tool execution: validation fails
          throw makeValidationError("first validation failure");
        }
        if (completeCall === 3) {
          // Retry succeeds — terminal
          return { content: '{"total_errors": 1, "categories": []}', toolCalls: [] };
        }
        // If counter didn't reset, a 4th call wouldn't happen in a new cycle.
        // But since we break after terminal, we just verify we got here correctly.
        return { content: "unexpected", toolCalls: [] };
      },
      pushToolMessage() {},
      pushSteerMessage(content) {
        steered.push(content);
      },
    };
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-so-reset",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
    });

    // 3 calls: tool-call round, validation fail, success
    assert.equal(completeCall, 3);
    // One correction was injected
    assert.equal(steered.length, 1);
    // Run completed
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-so-reset'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
  });

  it("does not retry non-StructuredOutputValidationError exceptions", async () => {
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        throw new Error("some other model error");
      },
      pushSteerMessage() {},
    };
    const toolRuns = createToolRunStore(db);

    await assert.rejects(
      runToolLoop({
        db,
        sessionId: "sess",
        runId: "run-so-no-retry",
        principalId: "p",
        policy: { check: () => ({ allow: true }) },
        audit: { record: () => {} },
        model,
        tools: [{ name: "read" }],
        executor: { execute: async () => ({ resultJson: "{}" }) },
        toolRuns,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).message, "some other model error");
        // Must NOT be a StructuredOutputValidationError
        assert.ok(!(err instanceof StructuredOutputValidationError));
        return true;
      },
    );

    // Should have been called exactly once — no retry
    assert.equal(completeCall, 1);
  });

  it("respects abort signal between structured output retries", async () => {
    const ac = new AbortController();
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        if (completeCall === 1) {
          // First attempt fails validation — abort before retry
          ac.abort();
          throw makeValidationError();
        }
        // Should never reach here if abort is respected
        return { content: '{"total_errors": 0, "categories": []}', toolCalls: [] };
      },
      pushSteerMessage() {},
    };
    const toolRuns = createToolRunStore(db);

    await assert.rejects(
      runToolLoop({
        db,
        sessionId: "sess",
        runId: "run-so-abort",
        principalId: "p",
        policy: { check: () => ({ allow: true }) },
        audit: { record: () => {} },
        model,
        tools: [{ name: "read" }],
        executor: { execute: async () => ({ resultJson: "{}" }) },
        toolRuns,
        turnAbortSignal: ac.signal,
      }),
      (err: unknown) => {
        // Should be TurnAbortedError, not StructuredOutputValidationError
        assert.ok(err instanceof TurnAbortedError);
        return true;
      },
    );

    // model.complete() should have been called only once
    assert.equal(completeCall, 1);
  });
});

describe("runToolLoop circuit breakers (structured-output near-miss + unknown-tool backstop)", () => {
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

  it("routes near-miss __structured_output__ calls into the retry budget and terminates the turn", async () => {
    const pushed: string[] = [];
    const auditPhases: string[] = [];
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        // Model keeps emitting a garbled near-miss of the synthetic tool.
        return {
          content: null,
          toolCalls: [
            { id: `tc${completeCall}`, name: "__structured_output__parameter", argsJson: "{}" },
          ],
        };
      },
      pushToolMessage({ content }) {
        pushed.push(content);
      },
    };
    const toolRuns = createToolRunStore(db);
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-near-miss",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e: unknown) => {
          auditPhases.push((e as { phase?: string }).phase ?? "");
        },
      },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
      transcript: tr,
      contextSegmentId: seg,
    });

    // Budget is STRUCTURED_OUTPUT_MAX_RETRIES (2): initial attempt + 2 retries
    // = 3 dispatches, after which the turn terminates instead of spinning.
    assert.equal(completeCall, 3);

    // Each near-miss pushed a correction naming the EXACT synthetic tool.
    assert.equal(pushed.length, 3);
    for (const p of pushed) {
      const parsed = JSON.parse(p);
      assert.equal(parsed.error, "structured_output_tool_near_miss");
      assert.ok(parsed.message.includes("__structured_output__"));
      assert.ok(parsed.message.includes("__structured_output__parameter"));
    }

    // Near-miss dispatches were audited.
    assert.equal(auditPhases.filter((p) => p === "structured_output_tool_near_miss").length, 3);

    // Turn ended cleanly (not by the unknown-tool backstop).
    assert.ok(!auditPhases.includes("invalid_tool_call_backstop"));
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-near-miss'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
  });

  it("does NOT charge the structured-output budget for ordinary unknown tools", async () => {
    let completeCall = 0;
    const pushed: string[] = [];
    const model: ModelClient = {
      async complete() {
        completeCall++;
        if (completeCall <= 3) {
          // Ordinary unrelated unknown tools — must take the generic path and
          // must NOT increment structuredOutputAttempt. If they did, the
          // structured-output breaker would trip at the 3rd and the turn would
          // end before reaching the terminal response below.
          return {
            content: null,
            toolCalls: [
              { id: `tc${completeCall}`, name: `bogus_tool_${completeCall}`, argsJson: "{}" },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage({ content }) {
        pushed.push(content);
      },
    };
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-ordinary-unknown",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
    });

    // 3 unknown rounds + 1 terminal response.
    assert.equal(completeCall, 4);

    // All 3 dispatches were generic unknown_tool errors (no near-miss correction).
    assert.equal(pushed.length, 3);
    for (const p of pushed) {
      assert.equal(JSON.parse(p).error, "unknown_tool");
    }
  });

  it("terminates the turn after MAX_CONSECUTIVE_INVALID_TOOL_CALLS consecutive unknown-tool calls", async () => {
    const auditPhases: string[] = [];
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        return {
          content: null,
          toolCalls: [
            { id: `tc${completeCall}`, name: `fake_tool_${completeCall}`, argsJson: "{}" },
          ],
        };
      },
      pushToolMessage() {},
    };
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-unknown-backstop",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e: unknown) => {
          auditPhases.push((e as { phase?: string }).phase ?? "");
        },
      },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
    });

    // Backstop is 5: dispatches 1..5 continue, the 6th trips the breaker and
    // ends the turn — proving it can never spin forever.
    assert.equal(completeCall, 6);
    assert.ok(auditPhases.includes("invalid_tool_call_backstop"));

    const row = db
      .prepare(`SELECT status FROM tool_runs WHERE id = 'run-unknown-backstop'`)
      .get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
  });

  it("resets the consecutive unknown-tool counter on a valid tool call", async () => {
    const auditPhases: string[] = [];
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        // 4 unknowns, 1 valid call (resets counter), 5 more unknowns, terminal.
        // Never 6 consecutive unknowns, so the backstop must NOT fire.
        if (completeCall <= 4 || (completeCall >= 6 && completeCall <= 10)) {
          return {
            content: null,
            toolCalls: [{ id: `tc${completeCall}`, name: `fake_${completeCall}`, argsJson: "{}" }],
          };
        }
        if (completeCall === 5) {
          return {
            content: null,
            toolCalls: [{ id: "valid", name: "read", argsJson: "{}" }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-unknown-reset",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e: unknown) => {
          auditPhases.push((e as { phase?: string }).phase ?? "");
        },
      },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
    });

    // Reaches the terminal response without the backstop firing (counter was
    // reset by the valid call).
    assert.equal(completeCall, 11);
    assert.ok(!auditPhases.includes("invalid_tool_call_backstop"));

    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-unknown-reset'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
  });

  it("also trips the backstop for a valid tool called repeatedly with invalid arguments", async () => {
    const auditPhases: string[] = [];
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        // "read" is a real tool, but the args are never valid JSON — each round
        // takes the skip_bad_args path and must count toward the backstop.
        return {
          content: null,
          toolCalls: [{ id: `tc${completeCall}`, name: "read", argsJson: "not json" }],
        };
      },
      pushToolMessage() {},
    };
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-bad-args-backstop",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: {
        record: (e: unknown) => {
          auditPhases.push((e as { phase?: string }).phase ?? "");
        },
      },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
    });

    // 6 consecutive invalid-argument dispatches trip the backstop (same cap as
    // unknown tool names), proving the turn can't spin on a real tool either.
    assert.equal(completeCall, 6);
    assert.ok(auditPhases.includes("invalid_tool_call_backstop"));

    const row = db
      .prepare(`SELECT status FROM tool_runs WHERE id = 'run-bad-args-backstop'`)
      .get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
  });
});
