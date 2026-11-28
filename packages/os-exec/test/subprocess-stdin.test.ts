import { describe, it } from "vitest";
import assert from "node:assert";
import { runAsUser, type RunAsUserOptions } from "../src/subprocess";

const OVERSIZED = "x".repeat(2048 * 1024);

function options(args: string[], stdin?: string): RunAsUserOptions {
  return {
    file: process.execPath,
    args,
    cwd: "/",
    uid: process.getuid(),
    gid: process.getgid(),
    stdin,
  };
}

describe("runAsUser (stdin handling)", () => {
  it("child that reads all stdin receives the full payload", async () => {
    const payload = "hello-stdin";
    const r = await runAsUser(options(["-e", "process.stdin.pipe(process.stdout)"], payload));
    assert.equal(r.exitCode, 0);
    assert.equal(r.signal, null);
    assert.equal(r.stdout, payload);
  });

  it("child that exits before reading stdin still resolves cleanly", async () => {
    const r = await runAsUser(options(["-e", "process.exit(0)"], OVERSIZED));
    assert.equal(r.exitCode, 0);
    assert.equal(r.signal, null);
  });

  it("keeps serving commands after stdin EPIPE", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await runAsUser(options(["-e", "process.exit(0)"], OVERSIZED));
      assert.equal(r.exitCode, 0);
    }
    const after = await runAsUser({
      file: "/usr/bin/id",
      args: ["-u"],
      cwd: "/",
      uid: process.getuid(),
      gid: process.getgid(),
    });
    assert.equal(after.exitCode, 0);
    assert.equal(after.stdout.trim(), String(process.getuid()));
  });

  it("child that reads only part of stdin still exits cleanly", async () => {
    const r = await runAsUser(
      options(["-e", "process.stdin.once('data', () => process.exit(0))"], OVERSIZED),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.signal, null);
  });
});
