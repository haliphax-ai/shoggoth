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
import { createLogger, setRootLogger } from "../../src/logging";
import { runToolLoop, type ModelClient } from "../../src/sessions/tool-loop";
import { pushSteer, _resetAllChannels } from "../../src/sessions/steer-channel";
import {
  registerActiveTurnSurface,
  _resetActiveTurnSurfaces,
} from "../../src/presentation/active-turn-surface";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-steer-"));
  const dbPath = join(dir, "s.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function stubLogger() {
  const logs: Array<{
    level: string;
    msg: string;
    fields?: Record<string, unknown>;
  }> = [];
  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    logs.push({ level, msg, fields });
  };
  const logger = {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: () => logger,
  };
  return { logger, logs };
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

  afterEach(async () => {
    _resetAllChannels();
    await closeTestDb(db, tmp);
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
          execute: async () => {
            throw new Error("boom");
          },
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

  it("appends steer messages to the transcript as user messages", async () => {
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
      pushToolMessage() {},
      pushSteerMessage() {},
    };
    const toolRuns = createToolRunStore(db);
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");

    const exec = vi.fn(async () => {
      pushSteer("sess", "persist this steer");
      return { resultJson: "{}" };
    });

    await runToolLoop({
      db,
      sessionId: "sess",
      runId: "run-steer-tx",
      principalId: "p",
      policy: { check: () => ({ allow: true }) },
      audit: { record: () => {} },
      model,
      tools: [{ name: "read" }],
      executor: { execute: exec },
      toolRuns,
      transcript: tr,
      contextSegmentId: seg,
    });

    const page = tr.listPage({ sessionId: "sess", contextSegmentId: seg, afterSeq: 0, limit: 100 });
    const steerRow = page.messages.find(
      (m) => m.role === "user" && (m.content ?? "").includes("persist this steer"),
    );
    assert.ok(steerRow, "steer message should be persisted in the transcript");
    assert.equal((steerRow!.metadata as { steer?: boolean } | undefined)?.steer, true);
  });

  it("logs the steering message content when injected into an active loop", async () => {
    const stub = stubLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRootLogger(stub.logger as any);
    try {
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
        pushToolMessage() {},
        pushSteerMessage() {},
      };
      const toolRuns = createToolRunStore(db);

      const exec = vi.fn(async () => {
        pushSteer("sess", "log this steer");
        return { resultJson: "{}" };
      });

      await runToolLoop({
        db,
        sessionId: "sess",
        runId: "run-steer-log",
        principalId: "p",
        policy: { check: () => ({ allow: true }) },
        audit: { record: () => {} },
        model,
        tools: [{ name: "read" }],
        executor: { execute: exec },
        toolRuns,
      });
    } finally {
      setRootLogger(createLogger({ component: "tool-loop-steer.test" }));
    }

    const entry = stub.logs.find(
      (l) =>
        l.msg.includes("steering message") &&
        String(l.fields?.message ?? "").includes("log this steer"),
    );
    assert.ok(entry, "steer message content should appear in the daemon logs");
    assert.equal(entry!.fields?.sessionId, "sess");
  });

  it("posts a 🫵 Steered banner to the active turn surface when injecting a steer", async () => {
    const notices: string[] = [];
    const { unregister } = registerActiveTurnSurface("sess", {
      captureAnchor: () => ({ committedProseSegments: 0, toolCalls: 0 }),
      onNotice: (n) => {
        notices.push(n);
      },
    });
    try {
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
        pushToolMessage() {},
        pushSteerMessage() {},
      };
      const toolRuns = createToolRunStore(db);

      const exec = vi.fn(async () => {
        pushSteer("sess", "change direction");
        return { resultJson: "{}" };
      });

      await runToolLoop({
        db,
        sessionId: "sess",
        runId: "run-steer-banner",
        principalId: "p",
        policy: { check: () => ({ allow: true }) },
        audit: { record: () => {} },
        model,
        tools: [{ name: "read" }],
        executor: { execute: exec },
        toolRuns,
      });

      assert.strictEqual(notices.length, 1, "exactly one steer banner per injected steer");
      assert.ok(
        notices[0]!.includes("> 🫵 **Steered:** change direction"),
        `unexpected banner: ${notices[0]}`,
      );
    } finally {
      unregister();
      _resetActiveTurnSurfaces();
    }
  });
});
