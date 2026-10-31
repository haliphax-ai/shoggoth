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
import {
  runToolLoop,
  ToolCallTruncatedError,
  type ModelClient,
} from "../../src/sessions/tool-loop";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-trunc-"));
  const dbPath = join(dir, "l.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

/**
 * A tool call whose arguments were cut off mid-JSON by the provider's
 * output-token limit — the exact shape that used to poison the next request.
 */
const TRUNCATED_ARGS = '{"path":"/tmp/very-large-file.txt","content":"line one\\nline two';

describe("runToolLoop — output-truncated tool call arguments", () => {
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

  it("surfaces an output-truncation error instead of healing args to {}", async () => {
    const pushed: { toolCallId: string; content: string }[] = [];
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-write", argsJson: TRUNCATED_ARGS }],
            // Provider stopped at the output-token limit.
            finishReason: "length",
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };

    // The turn fails with an explicit truncation error rather than an opaque
    // provider 400 on the follow-up request.
    const err = await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-trunc",
      principalId: "agent:sess",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-write" }],
      executor: { execute: exec },
      toolRuns: createToolRunStore(db),
    }).catch((e: unknown) => e);

    assert.ok(err instanceof ToolCallTruncatedError, `expected a truncation error, got ${err}`);
    assert.match(err.message, /truncated/i);
    assert.match(err.message, /split/i);

    // The call must never execute — the arguments are incomplete.
    assert.equal(exec.mock.calls.length, 0);

    // The model is told the call was TRUNCATED, so it can split the write and
    // retry with smaller arguments.
    assert.equal(pushed.length, 1);
    const parsed = JSON.parse(pushed[0]!.content);
    assert.equal(parsed.error, "output_truncated");
    assert.match(parsed.message, /split/i);

    // The model must NOT be asked again: a second request would carry the
    // broken arguments back to the provider.
    assert.equal(step, 1);
  });

  it("does not poison the next model request with unparseable arguments", async () => {
    const tr = createTranscriptStore(db);
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-write", argsJson: TRUNCATED_ARGS }],
            finishReason: "length",
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
    };

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-trunc-2",
      principalId: "agent:sess",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-write" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns: createToolRunStore(db),
      transcript: tr,
      contextSegmentId: getSessionContextSegmentId(db, "sess"),
    }).catch((e: unknown) => {
      assert.ok(e instanceof ToolCallTruncatedError);
    });

    // No second model request was made — the turn ended before the broken
    // call could be replayed to the provider.
    assert.equal(step, 1);

    // The transcript's assistant row must carry parseable arguments, so a
    // later replay (next turn, compaction) can map them to a provider
    // request without erroring.
    const seg = getSessionContextSegmentId(db, "sess");
    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 50 });
    const assistant = page.messages.filter((m) => m.role === "assistant" && m.toolCalls?.length);
    assert.equal(assistant.length, 1);
    const storedArgs = assistant[0]!.toolCalls![0]!.argsJson;
    assert.doesNotThrow(() => JSON.parse(storedArgs));
  });

  it("still reports malformed arguments as invalid_arguments when not truncated", async () => {
    const pushed: { toolCallId: string; content: string }[] = [];
    const exec = vi.fn(async () => ({ resultJson: "{}" }));
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-write", argsJson: "not valid json {{{" }],
            // The model finished normally — this is its own malformed JSON,
            // which it can fix by retrying.
            finishReason: "tool_calls",
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-malformed",
      principalId: "agent:sess",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "builtin-write" }],
      executor: { execute: exec },
      toolRuns: createToolRunStore(db),
    });

    assert.equal(exec.mock.calls.length, 0);
    assert.equal(pushed.length, 1);
    const parsed = JSON.parse(pushed[0]!.content);
    assert.equal(parsed.error, "invalid_arguments");
  });
});
