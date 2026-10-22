/**
 * Contract mode on the workflow spawn/poll adapters:
 * - spawn validates the contract's git repository at call time (killing the
 *   freshly spawned session and failing the spawn on violation)
 * - after the turn, the spawn adapter verifies the contract and records the
 *   verdict on the completion entry
 * - the poll adapter fails a "done" turn whose contract was not fulfilled
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDaemonSpawnAdapter,
  createDaemonPollAdapter,
  type CompletionMap,
  type DaemonSpawnAdapterDeps,
} from "../src/workflow-adapters.js";
import type { ContractStatus } from "../src/subagent/contract";
import type { ShoggothConfig } from "@shoggoth/shared";

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitFixtureEnv(),
  });
}

/** Strips hook/CI git env so fixture repos resolve by cwd, not GIT_DIR. */
function gitFixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@test.local",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@test.local",
    // Fixture repos must not inherit the operator's global/system git config
    // (commit signing, credential helpers, includes): identity comes from the
    // GIT_* vars above and repo-local `git config`, and a signing key or
    // include chain that fails on this host would fail every fixture commit.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  return env;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-contract-repo-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.local");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "baseline");
  return dir;
}

interface Fakes {
  sm: DaemonSpawnAdapterDeps["sessionManager"];
  sessions: DaemonSpawnAdapterDeps["sessions"];
  killed: string[];
}

function makeFakes(): Fakes {
  const killed: string[] = [];
  const sm: DaemonSpawnAdapterDeps["sessionManager"] = {
    spawn: async () => ({
      sessionId: "child-session-1",
      agentToken: "tok",
      agentTokenEnvName: "SHOGGOTH_AGENT_TOKEN" as const,
    }),
    kill: (id: string) => {
      killed.push(id);
    },
  } as never;
  const sessions = {
    update: () => {},
    getById: () => undefined,
  } as never as DaemonSpawnAdapterDeps["sessions"];
  return { sm, sessions, killed };
}

/** Completing fake runSessionModelTurn that applies a mutation to the repo. */
function makeTurn(mutate?: (dir: string) => Promise<void>) {
  const fn = async (_input: { sessionId: string }) => {
    if (mutate) await mutate(repoDirForTurn!);
    return { latestAssistantText: "done", failoverMeta: null };
  };
  return fn;
}
let repoDirForTurn: string | undefined;

const cfg = (): ShoggothConfig =>
  ({
    agents: { contract: { yesMinimum: 0.85, batchSize: 5 } },
    decision: { providers: {} },
  }) as ShoggothConfig;

describe("workflow spawn adapter contract mode", () => {
  beforeEach(() => {
    repoDirForTurn = undefined;
  });

  afterEach(() => {
    repoDirForTurn = undefined;
  });

  it("fails the spawn when a contract target is not in a git repository", async () => {
    const fakes = makeFakes();
    const dir = await mkdtemp(join(tmpdir(), "wf-contract-norepo-"));
    fakes.sessions = {
      update: () => {},
      getById: () => ({ workingDirectory: dir }),
    } as never;

    const adapter = createDaemonSpawnAdapter({
      sessionManager: fakes.sm,
      sessions: fakes.sessions,
      parentSessionId: "parent-1",
      runSessionModelTurn: makeTurn(),
      getContractConfig: () => cfg() as never,
    });

    await assert.rejects(
      adapter.spawn({
        taskId: 1,
        prompt: "do it",
        replyTo: "parent-1",
        timeoutMs: 60_000,
        contract: [{ path: "a.txt", action: "update", summary: "change it" }],
      }),
      /not in a git repository/,
    );
    assert.deepEqual(fakes.killed, ["child-session-1"], "spawned session must be killed");
    await rm(dir, { recursive: true, force: true });
  });

  it("fails the spawn when the judge model is not configured", async () => {
    const fakes = makeFakes();
    const dir = await makeRepo();
    repoDirForTurn = dir;
    fakes.sessions = {
      update: () => {},
      getById: () => ({ workingDirectory: dir }),
    } as never;

    const adapter = createDaemonSpawnAdapter({
      sessionManager: fakes.sm,
      sessions: fakes.sessions,
      parentSessionId: "parent-1",
      runSessionModelTurn: makeTurn(),
      getContractConfig: () => cfg() as never,
    });

    await assert.rejects(
      adapter.spawn({
        taskId: 1,
        prompt: "do it",
        replyTo: "parent-1",
        timeoutMs: 60_000,
        contract: [{ path: "a.txt", action: "update", summary: "change it" }],
        judge: "typesafe-main/nope",
      }),
      /judge model is not a configured decision provider\/model/,
    );
    assert.deepEqual(fakes.killed, ["child-session-1"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("verifies the contract after the turn and records a fulfilled verdict", async () => {
    const fakes = makeFakes();
    const dir = await makeRepo();
    repoDirForTurn = dir;
    fakes.sessions = {
      update: () => {},
      getById: () => ({ workingDirectory: dir }),
    } as never;

    const adapter = createDaemonSpawnAdapter({
      sessionManager: fakes.sm,
      sessions: fakes.sessions,
      parentSessionId: "parent-1",
      runSessionModelTurn: makeTurn(async (d) => {
        await writeFile(join(d, "a.txt"), "one\ntwo\n");
      }),
      getContractConfig: () => cfg() as never,
    });

    const key = await adapter.spawn({
      taskId: 1,
      prompt: "do it",
      replyTo: "parent-1",
      timeoutMs: 60_000,
      contract: [{ path: "a.txt", action: "update", summary: "append a line" }],
    });

    // Wait for the async turn + verification to settle
    await new Promise((r) => setTimeout(r, 100));
    const entry = adapter.completionMap.get(key);
    assert.ok(entry, "completion entry must exist");
    assert.equal(entry.ok, true);
    if (entry.ok) {
      const contract = entry.contract as ContractStatus | undefined;
      assert.ok(contract, "contract verdict must be recorded");
      // No decision provider configured for the fake → decision fails closed.
      assert.equal(contract.fulfilled, false);
      assert.match(contract.error ?? "", /decision/);
    }
    await rm(dir, { recursive: true, force: true });
  });
});

describe("workflow poll adapter contract mode", () => {
  it("returns failed when a done completion carries an unfulfilled contract", async () => {
    const completionMap: CompletionMap = new Map([
      [
        "child-1",
        {
          ok: true,
          output: "work product",
          completedAt: Date.now(),
          contract: {
            fulfilled: false,
            broken: false,
            yesMinimum: 0.85,
            entries: [],
            judged: [{ path: "a.txt", action: "update", yes: 0.4, fulfilled: false }],
            violated: [],
            deletedSkipped: [],
            baseline: "abc",
          },
        },
      ],
    ]);
    const poller = createDaemonPollAdapter({
      sessions: {
        getById: () => ({ status: "terminated" }),
      } as never,
      completionMap,
    });

    const res = await poller.poll("child-1");
    assert.equal(res.status, "failed");
    assert.match(res.error ?? "", /contract not fulfilled.*a\.txt/);
    assert.equal(res.contract?.fulfilled, false);
  });

  it("returns failed with a broken-contract reason", async () => {
    const completionMap: CompletionMap = new Map([
      [
        "child-1",
        {
          ok: true,
          output: "work product",
          completedAt: Date.now(),
          contract: {
            fulfilled: false,
            broken: true,
            yesMinimum: 0.85,
            entries: [],
            judged: [],
            violated: ["b.txt"],
            deletedSkipped: [],
            baseline: "abc",
          },
        },
      ],
    ]);
    const poller = createDaemonPollAdapter({
      sessions: {
        getById: () => ({ status: "terminated" }),
      } as never,
      completionMap,
    });

    const res = await poller.poll("child-1");
    assert.equal(res.status, "failed");
    assert.match(res.error ?? "", /contract broken/);
  });

  it("returns done with the verdict when the contract is fulfilled", async () => {
    const completionMap: CompletionMap = new Map([
      [
        "child-1",
        {
          ok: true,
          output: "work product",
          completedAt: Date.now(),
          contract: {
            fulfilled: true,
            broken: false,
            yesMinimum: 0.85,
            entries: [],
            judged: [{ path: "a.txt", action: "update", yes: 0.97, fulfilled: true }],
            violated: [],
            deletedSkipped: [],
            baseline: "abc",
          },
        },
      ],
    ]);
    const poller = createDaemonPollAdapter({
      sessions: {
        getById: () => ({ status: "terminated" }),
      } as never,
      completionMap,
    });

    const res = await poller.poll("child-1");
    assert.equal(res.status, "done");
    assert.equal(res.output, "work product");
    assert.equal(res.contract?.fulfilled, true);
  });
});
