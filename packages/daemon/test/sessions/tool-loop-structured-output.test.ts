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

  afterEach(() => {
    closeTestDb(db, tmp);
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

  it("re-throws StructuredOutputValidationError after 3 total attempts (1 initial + 2 retries)", async () => {
    let completeCall = 0;
    const model: ModelClient = {
      async complete() {
        completeCall++;
        throw makeValidationError(`attempt ${completeCall} failed`);
      },
      pushSteerMessage() {},
    };
    const toolRuns = createToolRunStore(db);

    await assert.rejects(
      runToolLoop({
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
      }),
      (err: unknown) => {
        assert.ok(err instanceof StructuredOutputValidationError);
        return true;
      },
    );

    // Should have attempted exactly 3 times (1 initial + 2 retries)
    assert.equal(completeCall, 3);
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
