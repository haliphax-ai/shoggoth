import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ProcessManager } from "@shoggoth/procman";
import { setProcessManager } from "@shoggoth/os-exec";
import { closeTestDb } from "../helpers/close-test-db";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerExec } from "../../src/sessions/builtin-handlers/exec-handler";
import {
  ExecNotifyScheduler,
  setExecNotifyScheduler,
  type ExecNotifyCompletion,
} from "../../src/exec/exec-notify-scheduler";
import { resolveExecMaxYieldMs } from "../../src/config/effective-runtime";
import type { ShoggothConfig } from "@shoggoth/shared";

const SESSION_ID = "agent:test:discord:channel:456";
const creds = { uid: process.getuid!(), gid: process.getgid!() };

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("builtin-exec notify + yield clamp", () => {
  let ws: string;
  let db: Database.Database;
  let dbDir: string;
  let pm: ProcessManager;
  let completions: ExecNotifyCompletion[];
  let scheduler: ExecNotifyScheduler;
  let seenNotifies: number[];

  function stubCtx(config: ShoggothConfig = {}): BuiltinToolContext {
    return {
      sessionId: SESSION_ID,
      db,
      config: config as never,
      env: {},
      workspacePath: ws,
      creds,
      orchestratorEnv: {},
      getAgentIntegrationInvoker: () => undefined,
      getProcessManager: () => pm,
      messageToolCtx: undefined,
      memoryConfig: { paths: [], embeddings: { enabled: false } },
      runtimeOpenaiBaseUrl: undefined,
      isSubagentSession: false,
      onNotifiesChanged: (count) => seenNotifies.push(count),
    };
  }

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-exec-notify-handler-"));
    const o = (() => {
      const dir = mkdtempSync(join(tmpdir(), "shoggoth-exec-notify-db-"));
      const database = openStateDb(join(dir, "test.db"));
      migrate(database, defaultMigrationsDir());
      return { db: database, dir };
    })();
    db = o.db;
    dbDir = o.dir;
    pm = new ProcessManager();
    setProcessManager(pm);
    completions = [];
    seenNotifies = [];
    scheduler = new ExecNotifyScheduler(async (c) => {
      completions.push(c);
    });
    setExecNotifyScheduler(scheduler);
  });

  afterEach(async () => {
    scheduler.shutdown();
    setExecNotifyScheduler(undefined as unknown as ExecNotifyScheduler);
    await pm.stopAll();
    setProcessManager(undefined);
    await closeTestDb(db, dbDir);
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("registers a notify handle by default for background exec", async () => {
    const reg = new BuiltinToolRegistry();
    registerExec(reg);
    const result = await reg.execute(
      "exec",
      { argv: ["sleep", "30"], background: true },
      stubCtx(),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.status, "running");
    assert.equal(parsed.notify, true);
    assert.equal(scheduler.countForSession(db, SESSION_ID), 1);
    assert.deepStrictEqual(seenNotifies, [1]);
    const rows = scheduler.listForSession(db, SESSION_ID);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.command, /sleep 30/);
  });

  it("skips tracking when notify: false", async () => {
    const reg = new BuiltinToolRegistry();
    registerExec(reg);
    const result = await reg.execute(
      "exec",
      { argv: ["sleep", "30"], background: true, notify: false },
      stubCtx(),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.notify, undefined);
    assert.equal(scheduler.countForSession(db, SESSION_ID), 0);
    assert.deepStrictEqual(seenNotifies, []);
  });

  it("clamps yieldMs to the configured cap instead of ignoring it", async () => {
    const reg = new BuiltinToolRegistry();
    registerExec(reg);
    const start = Date.now();
    const result = await reg.execute(
      "exec",
      { argv: ["sleep", "10"], yieldMs: 60_000 },
      stubCtx({ runtime: { execMaxYieldMs: 150 } }),
    );
    const elapsed = Date.now() - start;
    const parsed = JSON.parse(result.resultJson);
    // The 60 s request was clamped to the 150 ms cap: the call backgrounded
    // almost immediately instead of blocking for the full minute.
    assert.equal(parsed.status, "running");
    assert.equal(parsed.yielded, true);
    assert.ok(elapsed < 5_000, `expected backgrounding near the cap, took ${elapsed}ms`);
    // Clamped-yield backgrounding still registers the notify handle.
    assert.equal(scheduler.countForSession(db, SESSION_ID), 1);
  });

  it("delivers the completion with the exit code and output when the process finishes", async () => {
    const reg = new BuiltinToolRegistry();
    registerExec(reg);
    await reg.execute(
      "exec",
      { argv: ["/bin/sh", "-c", "echo done-478; exit 3"], background: true },
      stubCtx(),
    );
    const completion = await waitFor(() => completions[0]);
    assert.equal(completion.exitCode, 3);
    assert.ok(completion.stdout?.includes("done-478"));
    assert.equal(scheduler.countForSession(db, SESSION_ID), 0);
  });

  it("honors output-file options in the registered handle", async () => {
    const reg = new BuiltinToolRegistry();
    registerExec(reg);
    await reg.execute(
      "exec",
      {
        argv: ["sleep", "30"],
        background: true,
        outputFile: "tmp/bg-out.txt",
        splitStreams: true,
        maxOutput: 1234,
        truncation: "head",
      },
      stubCtx(),
    );
    const rows = scheduler.listForSession(db, SESSION_ID);
    assert.equal(rows[0]!.options.outputFile, "tmp/bg-out.txt");
    assert.equal(rows[0]!.options.splitStreams, true);
    assert.equal(rows[0]!.options.maxOutput, 1234);
    assert.equal(rows[0]!.options.truncation, "head");
  });
});

describe("resolveExecMaxYieldMs", () => {
  afterEach(() => {
    delete process.env.SHOGGOTH_EXEC_MAX_YIELD_MS;
  });

  it("defaults to 30000", () => {
    assert.equal(resolveExecMaxYieldMs({} as ShoggothConfig), 30_000);
  });

  it("honors runtime.execMaxYieldMs over the default", () => {
    assert.equal(
      resolveExecMaxYieldMs({ runtime: { execMaxYieldMs: 5_000 } } as ShoggothConfig),
      5_000,
    );
  });

  it("env SHOGGOTH_EXEC_MAX_YIELD_MS wins over config", () => {
    process.env.SHOGGOTH_EXEC_MAX_YIELD_MS = "1234";
    assert.equal(
      resolveExecMaxYieldMs({ runtime: { execMaxYieldMs: 5_000 } } as ShoggothConfig),
      1_234,
    );
  });
});
