import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import {
  runToolLoop,
  type ModelClient,
} from "../../src/sessions/tool-loop";
import { pushSteer, _resetAllChannels } from "../../src/sessions/steer-channel";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-steer-"));
  const dbPath = join(dir, "s.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("runToolLoop steer injection", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    createSessionStore(db).create({ id: "sess", workspacePath: "/w" });
  });

  afterEach(() => {
    _resetAllChannels();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("injects steer messages between tool calls as user messages", async () => {
    const pushed: { role: string; content: string }[] = [];
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
        return { content: "steered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push({ role: "tool", content: msg.content });
      },
      pushSteerMessage(content) {
        pushed.push({ role: "user", content });
      },
    };
    const toolRuns = createToolRunStore(db);

    const exec = vi.fn(async () => {
      pushSteer("sess", "change direction");
      return { resultJson: "{}" };
    });

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-steer",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: exec },
      toolRuns,
    });

    const steerMsgs = pushed.filter((m) => m.role === "user");
    assert.equal(steerMsgs.length, 1);
    assert.ok(steerMsgs[0]!.content.includes("change direction"));
  });

  it("injects multiple steer messages before next model.complete()", async () => {
    const pushed: { role: string; content: string }[] = [];
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
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push({ role: "tool", content: msg.content });
      },
      pushSteerMessage(content) {
        pushed.push({ role: "user", content });
      },
    };
    const toolRuns = createToolRunStore(db);

    const exec = vi.fn(async () => {
      pushSteer("sess", "first steer");
      pushSteer("sess", "second steer");
      return { resultJson: "{}" };
    });

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-multi-steer",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: exec },
      toolRuns,
    });

    const steerMsgs = pushed.filter((m) => m.role === "user");
    assert.equal(steerMsgs.length, 2);
    assert.ok(steerMsgs[0]!.content.includes("first steer"));
    assert.ok(steerMsgs[1]!.content.includes("second steer"));
  });

  it("cleans up steer channel on normal loop exit", async () => {
    const model: ModelClient = {
      async complete() {
        return { content: "done", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-cleanup",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
    });

    assert.equal(pushSteer("sess", "too late"), false);
  });

  it("cleans up steer channel on error exit", async () => {
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
        return { content: "done", toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);

    try {
      await runToolLoop({
        db,
        sessionId: "sess",
        runId: "run-err-cleanup",
        principalId: "p",
        policy: { check: () => ({ allow: true }) },
        audit: { record: () => {} },
        model,
        tools: [{ name: "read" }],
        executor: {
          execute: async () => { throw new Error("boom"); },
        },
        toolRuns,
      });
    } catch {
      // expected
    }

    assert.equal(pushSteer("sess", "too late"), false);
  });

  it("does nothing when no steer messages are pending", async () => {
    const pushed: { role: string; content: string }[] = [];
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
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push({ role: "tool", content: msg.content });
      },
      pushSteerMessage(content) {
        pushed.push({ role: "user", content });
      },
    };
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-no-steer",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: async () => ({ resultJson: "{}" }) },
      toolRuns,
    });

    const steerMsgs = pushed.filter((m) => m.role === "user");
    assert.equal(steerMsgs.length, 0);
  });
});
