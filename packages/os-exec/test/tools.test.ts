import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolRead, toolWrite, toolExec } from "../src/tools";

describe("minimal v1 tools (read / write / exec)", () => {
  let ws: string;
  const creds = { uid: process.getuid(), gid: process.getgid() };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-tools-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("toolRead returns file contents via dropped-priv child", async () => {
    mkdirSync(join(ws, "a"), { recursive: true });
    writeFileSync(join(ws, "a/b.txt"), "hello-tools");
    const text = await toolRead(ws, "a/b.txt", creds);
    assert.equal(text, "hello-tools");
  });

  it("toolWrite creates file as agent uid", async () => {
    await toolWrite(ws, { path: "out.txt", content: "wrote\n" }, creds);
    assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "wrote\n");
  });

  it("toolExec runs binary with cwd in workspace", async () => {
    const r = await toolExec(ws, ["/bin/pwd"], creds);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.trim().length > 0);
  });

  it("toolRead rejects paths outside workspace allowlist", async () => {
    writeFileSync(join(ws, "ok.txt"), "ok");
    await assert.rejects(() => toolRead(ws, "..", creds));
  });
});
