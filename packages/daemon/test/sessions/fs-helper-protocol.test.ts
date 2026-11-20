// Tests for the fs helper entry process: framing, dispatch, and op behavior.
// Spawns a real `node fs-helper-entry.mjs` and exchanges framed JSON lines.

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  statSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const entryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "sessions",
  "fs-helper-entry.mjs",
);

/** Driver for one helper child process with framed request/response. */
class HelperHandle {
  private readonly proc = spawn(process.execPath, [entryPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  private buffer = "";
  private readonly responses = new Map<string, Record<string, unknown>>();
  private readonly waiters = new Map<string, (value: Record<string, unknown>) => void>();
  private nextId = 1;
  private readonly exitCode: Promise<number | null>;

  constructor() {
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const nl = this.buffer.indexOf("\n");
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg.id as string;
        this.responses.set(id, msg);
        const waiter = this.waiters.get(id);
        if (waiter) {
          this.waiters.delete(id);
          waiter(msg);
        }
      }
    });
    this.proc.stderr!.on("data", () => {});
    this.exitCode = new Promise((resolve) => {
      this.proc.once("exit", (code) => resolve(code));
    });
  }

  /** Send one command and wait for its framed response. */
  request(action: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `r${this.nextId++}`;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.proc.stdin!.write(`${JSON.stringify({ id, action, params })}\n`);
    });
  }

  async close(): Promise<number | null> {
    this.proc.stdin!.end();
    return this.exitCode;
  }
}

describe("fs helper entry process", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fs-helper-entry-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("answers each framed command with exactly one framed response", async () => {
    const helper = new HelperHandle();
    const file = join(workspace, "a.txt");
    writeFileSync(file, "hello");

    const mkdirRes = await helper.request("mkdir", { src: join(workspace, "d1") });
    assert.strictEqual(mkdirRes.ok, true);

    const moveRes = await helper.request("move", {
      src: file,
      dst: join(workspace, "d1", "b.txt"),
    });
    assert.strictEqual(moveRes.ok, true);
    assert.ok(existsSync(join(workspace, "d1", "b.txt")));
    assert.ok(!existsSync(file));

    const copyRes = await helper.request("copy", {
      src: join(workspace, "d1", "b.txt"),
      dst: join(workspace, "c.txt"),
    });
    assert.strictEqual(copyRes.ok, true);
    assert.strictEqual(readFileSync(join(workspace, "c.txt"), "utf8"), "hello");

    const statRes = await helper.request("stat", { src: join(workspace, "c.txt") });
    assert.strictEqual(statRes.ok, true);
    const info = statRes.info as Record<string, unknown>;
    assert.strictEqual(info.type, "file");
    assert.strictEqual(info.size, 5);
    assert.strictEqual(typeof info.mtime, "string");
    assert.strictEqual(typeof info.mode, "string");
    assert.strictEqual(typeof info.uid, "number");

    const deleteRes = await helper.request("delete", { src: join(workspace, "c.txt") });
    assert.strictEqual(deleteRes.ok, true);
    assert.strictEqual(deleteRes.count, 1);
    assert.ok(!existsSync(join(workspace, "c.txt")));

    const code = await helper.close();
    assert.strictEqual(code, 0);
  });

  it("mkdir succeeds idempotently for an existing directory", async () => {
    const helper = new HelperHandle();
    mkdirSync(join(workspace, "exists"));
    const res = await helper.request("mkdir", { src: join(workspace, "exists") });
    assert.strictEqual(res.ok, true);
    await helper.close();
  });

  it("mkdir creates parents with recursive", async () => {
    const helper = new HelperHandle();
    const res = await helper.request("mkdir", {
      src: join(workspace, "a", "b", "c"),
      recursive: true,
    });
    assert.strictEqual(res.ok, true);
    assert.ok(statSync(join(workspace, "a", "b", "c")).isDirectory());
    await helper.close();
  });

  it("mkdir fails without recursive for missing parents", async () => {
    const helper = new HelperHandle();
    const res = await helper.request("mkdir", { src: join(workspace, "x", "y", "z") });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(typeof res.error, "string");
    await helper.close();
  });

  it("delete refuses non-empty directories without recursive and preserves content", async () => {
    const helper = new HelperHandle();
    mkdirSync(join(workspace, "full"));
    writeFileSync(join(workspace, "full", "inner.txt"), "keep");
    const res = await helper.request("delete", { src: join(workspace, "full") });
    assert.strictEqual(res.ok, false);
    assert.match(String(res.error), /recursive/);
    assert.strictEqual(readFileSync(join(workspace, "full", "inner.txt"), "utf8"), "keep");
    await helper.close();
  });

  it("delete counts nested entries with recursive", async () => {
    const helper = new HelperHandle();
    mkdirSync(join(workspace, "tree"));
    mkdirSync(join(workspace, "tree", "sub"));
    writeFileSync(join(workspace, "tree", "one.txt"), "1");
    writeFileSync(join(workspace, "tree", "sub", "two.txt"), "2");
    const res = await helper.request("delete", { src: join(workspace, "tree"), recursive: true });
    assert.strictEqual(res.ok, true);
    // two files + two directories
    assert.strictEqual(res.count, 4);
    assert.ok(!existsSync(join(workspace, "tree")));
    await helper.close();
  });

  it("stat follows symlinks for type but reports the lstat target", async () => {
    const helper = new HelperHandle();
    writeFileSync(join(workspace, "real.txt"), "abc");
    symlinkSync(join(workspace, "real.txt"), join(workspace, "link.txt"));
    const res = await helper.request("stat", { src: join(workspace, "link.txt") });
    assert.strictEqual(res.ok, true);
    const info = res.info as Record<string, unknown>;
    assert.strictEqual(info.type, "file");
    assert.strictEqual(info.size, 3);
    await helper.close();
  });

  it("chmod applies an octal mode", async () => {
    const helper = new HelperHandle();
    const file = join(workspace, "m.txt");
    writeFileSync(file, "mode");
    const res = await helper.request("chmod", { src: file, modeInt: "420" }); // 0o644
    assert.strictEqual(res.ok, true);
    assert.strictEqual(lstatSync(file).mode & 0o777, 0o644);
    await helper.close();
  });

  it("reports failures as {ok:false,error} without killing the process", async () => {
    const helper = new HelperHandle();
    const missing = join(workspace, "nope.txt");
    const res1 = await helper.request("stat", { src: missing });
    assert.strictEqual(res1.ok, false);
    assert.strictEqual(typeof res1.error, "string");

    // The process stays healthy and answers the next command.
    const res2 = await helper.request("mkdir", { src: join(workspace, "later") });
    assert.strictEqual(res2.ok, true);

    await helper.close();
  });

  it("responds with ok:false for unknown actions", async () => {
    const helper = new HelperHandle();
    const res = await helper.request("explode", {});
    assert.strictEqual(res.ok, false);
    assert.match(String(res.error), /unknown action/);
    await helper.close();
  });

  it("answers invalid JSON frames with an error result", async () => {
    const helper = new HelperHandle();
    // Write a raw bad frame directly, then verify the process recovers.
    const badId = await new Promise<Record<string, unknown>>((resolve) => {
      helper.proc.stdout!.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").split("\n")[0]!) as Record<string, unknown>);
      });
      helper.proc.stdin!.write("not json\n");
    });
    assert.strictEqual(badId.ok, false);
    assert.match(String(badId.error), /invalid JSON/);
    const after = await helper.request("mkdir", { src: join(workspace, "recovered") });
    assert.strictEqual(after.ok, true);
    await helper.close();
  });

  it("exits cleanly on stdin EOF", async () => {
    const helper = new HelperHandle();
    const code = await helper.close();
    assert.strictEqual(code, 0);
  });
});
