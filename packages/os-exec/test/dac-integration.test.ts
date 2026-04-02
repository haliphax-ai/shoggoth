/**
 * DAC integration: needs root + uid 901 spawn; CI matrix in shoggoth/docs/runbook.md.
 */
import { describe, it, beforeEach, afterEach, beforeAll } from "vitest";
import assert from "node:assert";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolRead } from "../src/tools";
import { runAsUser } from "../src/subprocess";
import { AbsolutePathRejectedError, resolvePathForRead } from "../src/workspace-path";

const AGENT_TEST_UID = 901;
const AGENT_TEST_GID = 901;
/** Matches Docker image `shoggoth` user (daemon); DAC tests use numeric chown — no passwd entry required. */
const SHOGGOTH_TEST_UID = 900;
const SHOGGOTH_TEST_GID = 900;

const CI_STRICT_AGENT = process.env.SHOGGOTH_CI_STRICT_AGENT_TESTS === "1";

function requireRootForDac(t: { skip: (m?: string) => void }, canDrop: boolean): boolean {
  if (!canDrop) {
    if (CI_STRICT_AGENT) {
      assert.fail("CI requires ability to spawn subprocess as uid/gid 901 (agent pool)");
    }
    t.skip(`cannot spawn as uid ${AGENT_TEST_UID} (need root or matching test setup)`);
    return false;
  }
  if (process.getuid() !== 0) {
    if (CI_STRICT_AGENT) {
      assert.fail("CI DAC tests must run as root (e.g. container default user)");
    }
    t.skip("need root to chown file to root for DAC denial");
    return false;
  }
  return true;
}

/** Exit 0 if read fails with EACCES/EPERM; 2 if read succeeded; 3 other error. */
async function assertAgentCannotReadAbsolutePath(absPath: string): Promise<void> {
  const r = await runAsUser({
    file: process.execPath,
    args: [
      "-e",
      `const fs=require('fs');const p=${JSON.stringify(absPath)};try{fs.readFileSync(p);process.exit(2)}catch(e){process.exit(['EACCES','EPERM'].includes(e.code)?0:3)}`,
    ],
    cwd: "/",
    uid: AGENT_TEST_UID,
    gid: AGENT_TEST_GID,
  });
  assert.strictEqual(
    r.exitCode,
    0,
    `expected EACCES/EPERM reading ${absPath}, got exit ${r.exitCode} stderr=${r.stderr}`,
  );
}

describe("DAC + deny sensitive paths (integration)", () => {
  let canDropToAgent: boolean;

  beforeAll(async () => {
    try {
      const r = await runAsUser({
        file: "/usr/bin/true",
        args: [],
        cwd: "/",
        uid: AGENT_TEST_UID,
        gid: AGENT_TEST_GID,
      });
      canDropToAgent = r.exitCode === 0;
    } catch {
      canDropToAgent = false;
    }
    if (CI_STRICT_AGENT) {
      assert.strictEqual(process.getuid(), 0, "SHOGGOTH_CI_STRICT_AGENT_TESTS=1 requires root");
      assert.ok(canDropToAgent, "SHOGGOTH_CI_STRICT_AGENT_TESTS=1 requires uid 901 spawn");
    }
  });

  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-dac-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("absolute paths are rejected before any subprocess (control socket, etc.)", () => {
    assert.throws(() => resolvePathForRead(ws, "/run/shoggoth/control.sock"), AbsolutePathRejectedError);
  });

  it("kernel DAC blocks agent uid reading root-only file inside workspace", async (t) => {
    if (!requireRootForDac(t, canDropToAgent)) {
      return;
    }
    const path = join(ws, "root-secret.txt");
    writeFileSync(path, "classified", { mode: 0o600 });
    chownSync(path, 0, 0);
    chmodSync(path, 0o600);
    await assert.rejects(
      () => toolRead(ws, "root-secret.txt", { uid: AGENT_TEST_UID, gid: AGENT_TEST_GID }),
      (e: unknown) => e instanceof Error && /toolRead failed|EACCES|EPERM/i.test((e as Error).message),
    );
  });

  it("kernel DAC blocks agent uid reading root-owned operator-style state tree", async (t) => {
    if (!requireRootForDac(t, canDropToAgent)) {
      return;
    }
    const fakeState = mkdtempSync(join(tmpdir(), "shoggoth-op-state-"));
    try {
      mkdirSync(join(fakeState, "nested"), { recursive: true });
      const secret = join(fakeState, "nested", "shoggoth.db");
      writeFileSync(secret, "operator-data", { mode: 0o600 });
      chownSync(secret, 0, 0);
      chmodSync(secret, 0o600);
      chownSync(join(fakeState, "nested"), 0, 0);
      chmodSync(join(fakeState, "nested"), 0o700);
      chownSync(fakeState, 0, 0);
      chmodSync(fakeState, 0o700);
      await assertAgentCannotReadAbsolutePath(secret);
    } finally {
      rmSync(fakeState, { recursive: true, force: true });
    }
  });

  it("kernel DAC blocks agent uid reading shoggoth-owned state file (matches container UID 900 layout)", async (t) => {
    if (!requireRootForDac(t, canDropToAgent)) {
      return;
    }
    const fakeState = mkdtempSync(join(tmpdir(), "shoggoth-daemon-state-"));
    try {
      const secret = join(fakeState, "shoggoth.db");
      writeFileSync(secret, "sqlite-bytes", { mode: 0o600 });
      chownSync(secret, SHOGGOTH_TEST_UID, SHOGGOTH_TEST_GID);
      chmodSync(secret, 0o600);
      chownSync(fakeState, SHOGGOTH_TEST_UID, SHOGGOTH_TEST_GID);
      chmodSync(fakeState, 0o700);
      await assertAgentCannotReadAbsolutePath(secret);
    } finally {
      rmSync(fakeState, { recursive: true, force: true });
    }
  });

  it("kernel DAC blocks agent uid reading file under shoggoth-owned 0750 tree (operator/config pattern)", async (t) => {
    if (!requireRootForDac(t, canDropToAgent)) {
      return;
    }
    const fakeOp = mkdtempSync(join(tmpdir(), "shoggoth-operator-tree-"));
    try {
      mkdirSync(join(fakeOp, "nested"), { recursive: true });
      const token = join(fakeOp, "nested", "token.txt");
      writeFileSync(token, "operator-secret", { mode: 0o600 });
      chownSync(token, SHOGGOTH_TEST_UID, SHOGGOTH_TEST_GID);
      chmodSync(token, 0o600);
      chownSync(join(fakeOp, "nested"), SHOGGOTH_TEST_UID, SHOGGOTH_TEST_GID);
      chmodSync(join(fakeOp, "nested"), 0o750);
      chownSync(fakeOp, SHOGGOTH_TEST_UID, SHOGGOTH_TEST_GID);
      chmodSync(fakeOp, 0o750);
      await assertAgentCannotReadAbsolutePath(token);
    } finally {
      rmSync(fakeOp, { recursive: true, force: true });
    }
  });

  it("kernel DAC blocks agent uid reading file in sibling peer workspace (0700 root)", async (t) => {
    if (!requireRootForDac(t, canDropToAgent)) {
      return;
    }
    const parent = mkdtempSync(join(tmpdir(), "shoggoth-peers-"));
    const wsA = join(parent, "session-a");
    const wsB = join(parent, "session-b");
    try {
      mkdirSync(wsA, { recursive: true });
      mkdirSync(wsB, { recursive: true });
      const peerSecret = join(wsB, "other-session.txt");
      writeFileSync(peerSecret, "peer-only", { mode: 0o600 });
      chownSync(peerSecret, 0, 0);
      chmodSync(peerSecret, 0o600);
      chownSync(wsB, 0, 0);
      chmodSync(wsB, 0o700);
      chownSync(wsA, 0, 0);
      chmodSync(wsA, 0o777);
      await assertAgentCannotReadAbsolutePath(peerSecret);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
