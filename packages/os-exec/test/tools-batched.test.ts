import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runAsUser } from "../src/subprocess";
import { toolReadExtended } from "../src/tools";
import type {
  ReadMultiResult,
  ReadSingleResult,
  StatMultiResult,
  StatSingleResult,
} from "../src/tools";

const creds = { uid: process.getuid(), gid: process.getgid() };
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "scripts");

interface BatchEntry {
  path: string;
  content?: string;
  error?: string;
}

/** Invoke a batched child script directly, mirroring how tools.ts spawns it. */
async function runBatchScript(
  script: string,
  entries: unknown,
  stdin?: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const r = await runAsUser({
    file: process.execPath,
    args: ["--import", tsxLoader, join(scriptsDir, script)],
    cwd: tmpdir(),
    uid: creds.uid,
    gid: creds.gid,
    stdin: stdin ?? JSON.stringify(entries),
    env: { SHOGGOTH_TOOL_STAT_LINE_LIMIT: String(10 * 1024 * 1024) },
    timeout: 120,
  });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

describe("batched read/stat child scripts", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-batch-"));
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "hello.txt"), "line1\nline2\nline3\nline4\nline5\n");
    writeFileSync(join(ws, "src/a.ts"), "const a = 1;\n");
    writeFileSync(join(ws, "src/b.ts"), "const b = 2;\n");
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("read-many.ts", () => {
    it("reads multiple files and preserves request order", async () => {
      const r = await runBatchScript("read-many.ts", [
        { path: "src/a.ts", absPath: join(ws, "src/a.ts") },
        { path: "src/b.ts", absPath: join(ws, "src/b.ts") },
      ]);
      assert.equal(r.exitCode, 0);
      const results = JSON.parse(r.stdout) as BatchEntry[];
      assert.deepEqual(
        results.map((x) => x.path),
        ["src/a.ts", "src/b.ts"],
      );
      assert.equal(results[0]!.content, "const a = 1;\n");
      assert.equal(results[1]!.content, "const b = 2;\n");
    });

    it("reports an error entry for a missing file without failing the batch", async () => {
      const r = await runBatchScript("read-many.ts", [
        { path: "src/a.ts", absPath: join(ws, "src/a.ts") },
        { path: "gone.txt", absPath: join(ws, "gone.txt") },
      ]);
      assert.equal(r.exitCode, 0);
      const results = JSON.parse(r.stdout) as BatchEntry[];
      assert.equal(results[0]!.content, "const a = 1;\n");
      assert.match(results[1]!.error!, /ENOENT/);
      assert.match(results[1]!.error!, /gone\.txt/);
    });

    it("returns full raw content (caps stay parent-side)", async () => {
      const big = `${"x".repeat(60 * 1024)}tail\n`;
      writeFileSync(join(ws, "big.txt"), big);
      const r = await runBatchScript("read-many.ts", [
        { path: "big.txt", absPath: join(ws, "big.txt") },
      ]);
      assert.equal(r.exitCode, 0);
      const results = JSON.parse(r.stdout) as BatchEntry[];
      assert.equal(results[0]!.content, big);
      assert.equal(results[0]!.error, undefined);
    });

    it("exits 1 with a stderr message on a malformed request envelope", async () => {
      const r = await runBatchScript("read-many.ts", undefined, "not json");
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /JSON/i);
      assert.equal(r.stdout, "");
    });
  });

  describe("stat-many.ts", () => {
    it("returns stat JSON for each path in order", async () => {
      const r = await runBatchScript("stat-many.ts", [
        { path: "hello.txt", absPath: join(ws, "hello.txt") },
        { path: "src", absPath: join(ws, "src") },
      ]);
      assert.equal(r.exitCode, 0);
      const results = JSON.parse(r.stdout) as Record<string, unknown>[];
      assert.equal(results[0]!.type, "file");
      assert.equal(typeof results[0]!.lines, "number");
      assert.equal(results[1]!.type, "directory");
    });

    it("returns an error entry for a missing path", async () => {
      const r = await runBatchScript("stat-many.ts", [
        { path: "nope.txt", absPath: join(ws, "nope.txt") },
      ]);
      assert.equal(r.exitCode, 0);
      const results = JSON.parse(r.stdout) as { path: string; error?: string }[];
      assert.match(results[0]!.error!, /ENOENT/);
      assert.equal(results[0]!.path, "nope.txt");
    });

    it("exits 1 with a stderr message on a malformed request envelope", async () => {
      const r = await runBatchScript("stat-many.ts", undefined, "not json");
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /JSON/i);
      assert.equal(r.stdout, "");
    });
  });
});

describe("toolReadExtended batching (multi-file loops)", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "shoggoth-read-ext-"));
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "data"), { recursive: true });
    writeFileSync(join(ws, "hello.txt"), "line1\nline2\nline3\nline4\nline5\n");
    writeFileSync(join(ws, "src/a.ts"), "const a = 1;\n");
    writeFileSync(join(ws, "src/b.ts"), "const b = 2;\n");
    writeFileSync(join(ws, "src/c.js"), "const c = 3;\n");
    writeFileSync(join(ws, "data/info.json"), '{"key":"value"}\n');
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("multi-file read results match the single-file path (order, content)", async () => {
    const multi = (await toolReadExtended(
      ws,
      { paths: ["src/a.ts", "hello.txt", "data/info.json"] },
      creds,
    )) as ReadMultiResult;
    assert.equal(multi.kind, "multi");

    const singleA = (await toolReadExtended(ws, { path: "src/a.ts" }, creds)) as ReadSingleResult;
    const singleHello = (await toolReadExtended(
      ws,
      { path: "hello.txt" },
      creds,
    )) as ReadSingleResult;
    const singleInfo = (await toolReadExtended(
      ws,
      { path: "data/info.json" },
      creds,
    )) as ReadSingleResult;

    assert.equal(multi.files["src/a.ts"], singleA.content);
    assert.equal(multi.files["hello.txt"], singleHello.content);
    assert.equal(multi.files["data/info.json"], singleInfo.content);
    assert.deepEqual(Object.keys(multi.files), ["src/a.ts", "hello.txt", "data/info.json"]);
    assert.equal(multi.notices, undefined);
  });

  it("per-file truncation notice and cap still apply in a batched read", async () => {
    writeFileSync(join(ws, "data/big.txt"), `${"x".repeat(60 * 1024)}tail\n`);
    const multi = (await toolReadExtended(
      ws,
      { paths: ["data/big.txt"] },
      creds,
    )) as ReadMultiResult;
    assert.ok(multi.notices?.some((n) => n.includes("data/big.txt") && n.includes("truncated")));
    const truncated = multi.files["data/big.txt"]!;
    assert.ok(truncated.length < 60 * 1024);
    assert.ok(truncated.startsWith("xxxx"));
    assert.ok(Buffer.byteLength(truncated, "utf8") <= 50 * 1024);
  });

  it("total response budget omits later files exactly as before", async () => {
    writeFileSync(join(ws, "data/big.txt"), `${"x".repeat(60 * 1024)}tail\n`);
    const multi = (await toolReadExtended(
      ws,
      { paths: ["data/big.txt", "hello.txt"] },
      creds,
    )) as ReadMultiResult;
    assert.ok("data/big.txt" in multi.files);
    assert.ok(!("hello.txt" in multi.files));
    assert.ok(multi.notices?.some((n) => n.includes("hello.txt") && n.includes("omitted")));
  });

  it("a bad path inside the batch becomes an error entry, not a corrupt batch", async () => {
    const multi = (await toolReadExtended(
      ws,
      { paths: ["src/a.ts", "../outside.txt", "hello.txt"] },
      creds,
    )) as ReadMultiResult;
    assert.equal(multi.kind, "multi");
    assert.equal(multi.files["src/a.ts"], "const a = 1;\n");
    assert.equal(multi.files["hello.txt"], "line1\nline2\nline3\nline4\nline5\n");
    assert.ok(multi.files["../outside.txt"]?.startsWith("[error:"));
    assert.ok(multi.notices?.some((n) => n.includes("../outside.txt")));
  });

  it("line ranges still apply per file in a multi-file read", async () => {
    const multi = (await toolReadExtended(
      ws,
      { paths: ["src/a.ts", "src/b.ts"], toLine: 1 },
      creds,
    )) as ReadMultiResult;
    assert.equal(multi.files["src/a.ts"], "const a = 1;");
    assert.equal(multi.files["src/b.ts"], "const b = 2;");
  });

  it("line range beyond the per-file cap still works (slice before truncate)", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`);
    writeFileSync(join(ws, "data/long.txt"), `${lines.join("\n")}\n`);
    const multi = (await toolReadExtended(
      ws,
      { paths: ["data/long.txt"], fromLine: 2500, toLine: 2510 },
      creds,
    )) as ReadMultiResult;
    assert.equal(
      multi.files["data/long.txt"],
      "L2500\nL2501\nL2502\nL2503\nL2504\nL2505\nL2506\nL2507\nL2508\nL2509\nL2510",
    );
  });

  it("multi-file stat matches per-file stat shape, order, and values", async () => {
    const multi = (await toolReadExtended(
      ws,
      { paths: ["hello.txt", "src", "nope.txt"], stat: true },
      creds,
    )) as StatMultiResult;
    assert.equal(multi.kind, "stat-multi");
    assert.equal(multi.stats.length, 3);
    assert.equal(multi.stats[0]!.path, "hello.txt");
    assert.equal(multi.stats[0]!.type, "file");
    assert.ok(typeof multi.stats[0]!.lines === "number");
    assert.equal(multi.stats[1]!.type, "directory");

    const single = (await toolReadExtended(
      ws,
      { path: "hello.txt", stat: true },
      creds,
    )) as StatSingleResult;
    assert.equal(multi.stats[0]!.size, single.stat.size);
    assert.equal(multi.stats[0]!.lines, single.stat.lines);

    const err = multi.stats[2]!;
    assert.ok(err.error, "expected error entry for missing file");
    assert.equal(err.path, "nope.txt");
  });

  it("multi-stat glob keeps symlink identity (child lstat on logical path)", async () => {
    symlinkSync(join(ws, "hello.txt"), join(ws, "link.txt"));
    const multi = (await toolReadExtended(
      ws,
      { paths: ["*.txt"], stat: true },
      creds,
    )) as StatMultiResult;
    const link = multi.stats.find((s) => s.path === "link.txt");
    const plain = multi.stats.find((s) => s.path === "hello.txt");
    assert.ok(link, "expected link.txt in glob matches");
    assert.ok(plain, "expected hello.txt in glob matches");
    assert.equal(link.symlink, true);
    assert.ok(link.target?.includes("hello.txt"));
    assert.equal(link.type, "file");
    assert.equal(plain.symlink, undefined);
  });

  it("stat multi on empty glob result returns empty stats array", async () => {
    const r = (await toolReadExtended(
      ws,
      { paths: ["nonexistent/*.xyz"], stat: true },
      creds,
    )) as StatMultiResult;
    assert.equal(r.kind, "stat-multi");
    assert.equal(r.stats.length, 0);
  });
});
