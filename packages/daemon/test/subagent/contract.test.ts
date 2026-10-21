/**
 * Contract mode: parsing, repository validation, structural checks, and
 * batched decision-model judging of per-file diffs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

import * as childProcess from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseContract,
  validateContractRepository,
  verifyContract,
  CONTRACT_YES_MINIMUM_DEFAULT,
} from "../../src/subagent/contract";
import type { ShoggothContractEntry } from "@shoggoth/shared";
import type { ShoggothConfig } from "@shoggoth/shared";

type ExecSpied = ReturnType<typeof vi.fn> & { getMockImplementation(): unknown };

/** Tracked spy on `node:child_process.execFileSync` (mocked above). */
const execFileSyncSpy = childProcess.execFileSync as unknown as ExecSpied;

/** Delegate handed to the spy by default: the real implementation. */
const actualChildProcess =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

function resetExecDelegate(): void {
  execFileSyncSpy.mockImplementation(actualChildProcess.execFileSync as never);
}

beforeEach(() => {
  resetExecDelegate();
  execFileSyncSpy.mockClear();
});

function git(dir: string, ...args: string[]): void {
  childProcess.execFileSync("git", args, {
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
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  return env;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "contract-repo-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.local");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "baseline");
  return dir;
}

function config(overrides: Partial<ShoggothConfig> = {}): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: "/tmp/state.db",
    socketPath: "/tmp/c.sock",
    workspacesRoot: "/tmp/workspaces",
    secretsDirectory: "/tmp/secrets",
    inboundMediaRoot: "/tmp/media",
    configDirectory: "/tmp/config",
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: {}, poolScope: "global" },
    ...overrides,
  } as ShoggothConfig;
}

const entry = (
  path: string,
  action: "create" | "update" | "delete",
  summary = "expected change",
): ShoggothContractEntry => ({ path, action, summary });

describe("parseContract", () => {
  it("returns undefined for unset or empty contract (mode inactive)", () => {
    expect(parseContract(undefined)).toBeUndefined();
    expect(parseContract(null)).toBeUndefined();
    expect(parseContract([])).toBeUndefined();
  });

  it("parses valid entries", () => {
    const parsed = parseContract([{ path: "src/a.ts", action: "create", summary: "add module" }]);
    assert.deepEqual(parsed, [{ path: "src/a.ts", action: "create", summary: "add module" }]);
  });

  it("rejects non-array input", () => {
    assert.throws(() => parseContract({ path: "a" }), /must be an array/);
  });

  it("rejects an invalid action", () => {
    assert.throws(
      () => parseContract([{ path: "a.ts", action: "move", summary: "s" }]),
      /create, update, or delete/,
    );
  });

  it("rejects missing path or summary", () => {
    assert.throws(
      () => parseContract([{ path: " ", action: "create", summary: "s" }]),
      /path must be/,
    );
    assert.throws(
      () => parseContract([{ path: "a", action: "create", summary: " " }]),
      /summary must be/,
    );
  });
});

describe("validateContractRepository", () => {
  it("fails when the working directory is not in a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-norepo-"));
    const res = validateContractRepository(dir, [entry("a.txt", "update")]);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /not in a git repository/);
    await rm(dir, { recursive: true, force: true });
  });

  it("fails when a target escapes the repository", async () => {
    const dir = await makeRepo();
    const res = validateContractRepository(dir, [entry("../outside.txt", "update")]);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /escapes the git repository/);
    await rm(dir, { recursive: true, force: true });
  });

  it("passes when all targets are inside the repository", async () => {
    const dir = await makeRepo();
    const res = validateContractRepository(dir, [entry("a.txt", "update")]);
    assert.equal(res.ok, true);
    assert.equal(res.repoDir, dir);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("contract git credentials", () => {
  it("passes explicit credentials to every git invocation", async () => {
    const dir = await makeRepo();
    execFileSyncSpy.mockImplementationOnce(() => `${dir}\n`);
    const res = validateContractRepository(dir, [entry("a.txt", "update")], {
      uid: 4242,
      gid: 4242,
    });
    assert.equal(res.ok, true);
    const opts = execFileSyncSpy.mock.calls.at(-1)?.[2] as
      | { uid?: number; gid?: number }
      | undefined;
    assert.equal(opts?.uid, 4242);
    assert.equal(opts?.gid, 4242);
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to the configured agent credentials", async () => {
    const dir = await makeRepo();
    const prev = process.env.SHOGGOTH_AGENT_UID;
    process.env.SHOGGOTH_AGENT_UID = "4343";
    try {
      execFileSyncSpy.mockImplementationOnce(() => `${dir}\n`);
      const res = validateContractRepository(dir, [entry("a.txt", "update")]);
      assert.equal(res.ok, true);
      const opts = execFileSyncSpy.mock.calls.at(-1)?.[2] as
        | { uid?: number; gid?: number }
        | undefined;
      assert.equal(opts?.uid, 4343);
      assert.equal(opts?.gid, 4343);
    } finally {
      if (prev === undefined) delete process.env.SHOGGOTH_AGENT_UID;
      else process.env.SHOGGOTH_AGENT_UID = prev;
    }
    await rm(dir, { recursive: true, force: true });
  });

  for (const [label, creds] of [
    ["default creds", undefined],
    ["explicit creds", { uid: 900, gid: 900 }],
  ] as const) {
    it(`retries as the current user when the uid switch is not permitted (${label})`, async () => {
      if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return;
      const selfUid = process.getuid();
      const dir = await makeRepo();
      execFileSyncSpy.mockImplementation((...args: unknown[]) => {
        const opts = args[2] as { uid?: number } | undefined;
        if (opts?.uid !== selfUid) {
          const err = new Error("EPERM: operation not permitted, uv_spawn") as Error & {
            code?: string;
          };
          err.code = "EPERM";
          throw err;
        }
        return Reflect.apply(actualChildProcess.execFileSync, null, args);
      });
      try {
        const res = validateContractRepository(
          dir,
          [entry("a.txt", "update")],
          creds as { uid: number; gid: number } | undefined,
        );
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.equal(res.repoDir, dir);
      } finally {
        resetExecDelegate();
      }
      await rm(dir, { recursive: true, force: true });
    });
  }

  it("falls back when the switch is refused with EACCES", async () => {
    if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return;
    const selfUid = process.getuid();
    const dir = await makeRepo();
    execFileSyncSpy.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { uid?: number } | undefined;
      if (opts?.uid !== selfUid) {
        const err = new Error("EACCES: permission denied, uv_spawn") as Error & { code?: string };
        err.code = "EACCES";
        throw err;
      }
      return Reflect.apply(actualChildProcess.execFileSync, null, args);
    });
    try {
      const res = validateContractRepository(dir, [entry("a.txt", "update")], {
        uid: 900,
        gid: 900,
      });
      assert.equal(res.ok, true, JSON.stringify(res));
    } finally {
      resetExecDelegate();
    }
    await rm(dir, { recursive: true, force: true });
  });
});

describe("verifyContract", () => {
  it("fails with an error when not in a git repository at call time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contract-norepo-2-"));
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "update")],
      config: config(),
    });
    assert.equal(status.fulfilled, false);
    assert.match(status.error ?? "", /not in a git repository/);
    await rm(dir, { recursive: true, force: true });
  });

  it("marks create fulfilled when the file exists and the decision says yes", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "b.txt"), "two\n");
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("b.txt", "create", "add b.txt")],
      config: config(),
      runDecision: async () => ({ contract_0: { noul: 0.97 } }),
    });
    assert.equal(status.fulfilled, true);
    assert.equal(status.broken, false);
    assert.equal(status.judged.length, 1);
    assert.equal(status.judged[0].yes, 0.97);
    await rm(dir, { recursive: true, force: true });
  });

  it("marks update fulfilled when the file was modified and judged yes", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "update", "append a line")],
      config: config(),
      runDecision: async () => ({ contract_0: { noul: 0.9 } }),
    });
    assert.equal(status.fulfilled, true);
    assert.match(status.judged[0].path, /a\.txt/);
    await rm(dir, { recursive: true, force: true });
  });

  it("breaks the contract when a target was not acted upon with its type", async () => {
    const dir = await makeRepo();
    let decided = false;
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "update", "no change was made")],
      config: config(),
      runDecision: async () => {
        decided = true;
        return { contract_0: { noul: 0.99 } };
      },
    });
    assert.equal(status.broken, true);
    assert.equal(status.fulfilled, false);
    assert.deepEqual(status.violated, ["a.txt"]);
    assert.equal(decided, false, "decision must not run for a structural break");
    await rm(dir, { recursive: true, force: true });
  });

  it("breaks create when the file already existed in the baseline", async () => {
    const dir = await makeRepo();
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "create", "should not exist yet")],
      config: config(),
      runDecision: async () => ({ contract_0: { noul: 0.99 } }),
    });
    assert.equal(status.broken, true);
    assert.deepEqual(status.violated, ["a.txt"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("passes delete entries structurally without sending them to the decision model", async () => {
    const dir = await makeRepo();
    await rm(join(dir, "a.txt"));
    let decided = false;
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "delete", "remove a.txt")],
      config: config(),
      runDecision: async () => {
        decided = true;
        return {};
      },
    });
    assert.equal(status.fulfilled, true);
    assert.equal(status.broken, false);
    assert.deepEqual(status.deletedSkipped, ["a.txt"]);
    assert.equal(status.judged.length, 0);
    assert.equal(decided, false, "deleted files are not sent to the decision model");
    await rm(dir, { recursive: true, force: true });
  });

  it("fails when the yes probability is below the configured minimum", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "a.txt"), "changed\n");
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "update", "append a line")],
      config: config(),
      runDecision: async () => ({ contract_0: { noul: CONTRACT_YES_MINIMUM_DEFAULT - 0.1 } }),
    });
    assert.equal(status.fulfilled, false);
    assert.equal(status.broken, false);
    assert.equal(status.judged[0].fulfilled, false);
    await rm(dir, { recursive: true, force: true });
  });

  it("respects a custom yesMinimum from config", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "a.txt"), "changed\n");
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "update", "append a line")],
      config: config({ agents: { contract: { yesMinimum: 0.5 } } }),
      runDecision: async () => ({ contract_0: { noul: 0.6 } }),
    });
    assert.equal(status.fulfilled, true);
    assert.equal(status.yesMinimum, 0.5);
    await rm(dir, { recursive: true, force: true });
  });

  it("judges entries in batches of batchSize (default 5)", async () => {
    const dir = await makeRepo();
    const entries: ShoggothContractEntry[] = [];
    for (let i = 0; i < 7; i++) {
      const name = `new${i}.txt`;
      await writeFile(join(dir, name), `${i}\n`);
      entries.push(entry(name, "create", `add ${name}`));
    }
    const batchSizes: number[] = [];
    const status = await verifyContract({
      cwd: dir,
      entries,
      config: config(),
      runDecision: async ({ questions }) => {
        batchSizes.push(Object.keys(questions).length);
        const answers: Record<string, unknown> = {};
        for (const key of Object.keys(questions)) answers[key] = { noul: 0.95 };
        return answers;
      },
    });
    assert.deepEqual(batchSizes, [5, 2]);
    assert.equal(status.judged.length, 7);
    assert.equal(status.fulfilled, true);
    await rm(dir, { recursive: true, force: true });
  });

  it("fails closed when the decision call errors", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "a.txt"), "changed\n");
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "update", "append a line")],
      config: config(),
      runDecision: async () => ({ error: "provider down" }),
    });
    assert.equal(status.fulfilled, false);
    assert.match(status.error ?? "", /provider down/);
    await rm(dir, { recursive: true, force: true });
  });

  it("supports absolute contract paths inside the repository", async () => {
    const dir = await makeRepo();
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), "changed\n");
    const status = await verifyContract({
      cwd: join(dir, "sub"),
      entries: [entry(join(dir, "a.txt"), "update", "append a line")],
      config: config(),
      runDecision: async () => ({ contract_0: { noul: 0.95 } }),
    });
    assert.equal(status.fulfilled, true);
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the source branch as baseline when provided and resolvable", async () => {
    const dir = await makeRepo();
    git(dir, "checkout", "-b", "feature-x");
    await writeFile(join(dir, "a.txt"), "changed on branch\n");
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "update", "append a line")],
      sourceBranch: "feature-x",
      config: config(),
      runDecision: async () => ({ contract_0: { noul: 0.99 } }),
    });
    assert.equal(status.fulfilled, true);
    assert.equal(status.baseline, "feature-x");
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to HEAD when the source branch does not exist", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "a.txt"), "changed\n");
    const status = await verifyContract({
      cwd: dir,
      entries: [entry("a.txt", "update", "append a line")],
      sourceBranch: "no-such-branch",
      config: config(),
      runDecision: async () => ({ contract_0: { noul: 0.99 } }),
    });
    assert.equal(status.fulfilled, true);
    assert.notEqual(status.baseline, "no-such-branch");
    await rm(dir, { recursive: true, force: true });
  });
});
