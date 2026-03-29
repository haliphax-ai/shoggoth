import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AbsolutePathRejectedError,
  PathEscapeError,
  resolvePathForRead,
  resolvePathForWrite,
} from "../src/workspace-path";

describe("workspace path allowlist", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("rejects absolute paths", () => {
    writeFileSync(join(ws, "a.txt"), "x");
    assert.throws(() => resolvePathForRead(ws, "/etc/passwd"), AbsolutePathRejectedError);
  });

  it("rejects traversal outside workspace", () => {
    writeFileSync(join(ws, "a.txt"), "x");
    assert.throws(() => resolvePathForRead(ws, ".."), PathEscapeError);
    assert.throws(() => resolvePathForRead(ws, "../../.."), PathEscapeError);
  });

  it("resolves a file inside workspace for read", () => {
    mkdirSync(join(ws, "sub"), { recursive: true });
    writeFileSync(join(ws, "sub/hello.txt"), "hi");
    const p = resolvePathForRead(ws, "sub/hello.txt");
    assert.ok(p.endsWith("hello.txt"));
  });

  it("rejects symlink escape to outside path on read", () => {
    const outside = mkdtempSync(join(tmpdir(), "shoggoth-out-"));
    try {
      writeFileSync(join(outside, "secret"), "nope");
      symlinkSync(join(outside, "secret"), join(ws, "link"));
      assert.throws(() => resolvePathForRead(ws, "link"), PathEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("resolvePathForWrite rejects traversal and allows new file under workspace", () => {
    mkdirSync(join(ws, "d"), { recursive: true });
    const p = resolvePathForWrite(ws, "d/new.txt");
    assert.ok(p.includes("d"));
    assert.ok(p.endsWith("new.txt"));
    assert.throws(() => resolvePathForWrite(ws, "../../../tmp/x"), PathEscapeError);
  });
});
