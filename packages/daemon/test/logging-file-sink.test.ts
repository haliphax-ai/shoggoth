import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  FileLogSink,
  createLogger,
  initFileLogging,
  flushFileLogging,
  closeFileLogging,
  getFileLoggingStats,
} from "../src/logging";

const FIXED_NOW = new Date("2026-03-01T12:00:00Z");

describe("FileLogSink", () => {
  let dir: string;
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-logsink-"));
    // Silence stderr noise (log lines and degradation warnings).
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(async () => {
    await closeFileLogging();
    process.stderr.write = origWrite;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes enqueued lines to the date-stamped file on flush", async () => {
    const sink = new FileLogSink({ dir, now: () => FIXED_NOW });
    sink.enqueue('{"n":1}\n');
    sink.enqueue('{"n":2}\n');
    await sink.flush();
    const content = readFileSync(join(dir, "shoggoth-2026-03-01.log"), "utf8");
    assert.equal(content, '{"n":1}\n{"n":2}\n');
    await sink.close();
  });

  it("drops new entries when the queue is full and reports the count once drained", async () => {
    const sink = new FileLogSink({ dir, maxQueue: 5, now: () => FIXED_NOW });
    for (let i = 0; i < 10; i++) {
      sink.enqueue(`{"n":${i}}\n`);
    }
    assert.equal(sink.pending, 5);
    assert.equal(sink.dropped, 5);
    await sink.flush();

    const lines = readFileSync(join(dir, "shoggoth-2026-03-01.log"), "utf8").trim().split("\n");
    // 5 kept entries + 1 drop report
    assert.equal(lines.length, 6);
    assert.equal(JSON.parse(lines[0]!).n, 0);
    assert.equal(JSON.parse(lines[4]!).n, 4);
    const report = JSON.parse(lines[5]!);
    assert.match(String(report.msg), /dropped entries/);
    assert.equal(report.dropped, 5);
    assert.equal(sink.dropped, 0);
    await sink.close();
  });

  it("rotates on date rollover and gzips the previous file", async () => {
    let current = new Date("2026-03-01T23:59:00Z");
    const sink = new FileLogSink({ dir, now: () => current });
    sink.enqueue('{"day":1}\n');
    await sink.flush();

    current = new Date("2026-03-02T00:01:00Z");
    sink.enqueue('{"day":2}\n');
    await sink.flush();

    assert.ok(existsSync(join(dir, "shoggoth-2026-03-01.log.gz")));
    assert.ok(!existsSync(join(dir, "shoggoth-2026-03-01.log")));
    const gz = gunzipSync(readFileSync(join(dir, "shoggoth-2026-03-01.log.gz"))).toString("utf8");
    assert.equal(gz, '{"day":1}\n');
    assert.equal(readFileSync(join(dir, "shoggoth-2026-03-02.log"), "utf8"), '{"day":2}\n');
    await sink.close();
  });

  it("prunes rotated archives beyond maxFiles", async () => {
    let current = new Date("2026-04-01T10:00:00Z");
    const sink = new FileLogSink({ dir, maxFiles: 2, now: () => current });
    for (let day = 1; day <= 4; day++) {
      current = new Date(`2026-04-0${day}T10:00:00Z`);
      sink.enqueue(`{"day":${day}}\n`);
      await sink.flush();
    }
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, [
      "shoggoth-2026-04-02.log.gz",
      "shoggoth-2026-04-03.log.gz",
      "shoggoth-2026-04-04.log",
    ]);
    await sink.close();
  });
});

describe("initFileLogging", () => {
  let dir: string;
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-logsink-"));
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(async () => {
    await closeFileLogging();
    process.stderr.write = origWrite;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes logger output to the file sink", async () => {
    const sink = initFileLogging({ dir, now: () => FIXED_NOW });
    assert.ok(sink);

    const log = createLogger({ component: "itest" });
    log.info("to file", { k: 1 });
    await flushFileLogging();

    const row = JSON.parse(readFileSync(join(dir, "shoggoth-2026-03-01.log"), "utf8").trim());
    assert.equal(row.msg, "to file");
    assert.equal(row.component, "itest");
    assert.equal(row.k, 1);
    assert.equal(getFileLoggingStats()?.pending, 0);
  });

  it("is a no-op when disabled", async () => {
    const sink = initFileLogging({ enabled: false, dir });
    assert.equal(sink, undefined);

    const log = createLogger({ component: "itest" });
    log.info("not captured");
    await flushFileLogging();

    assert.equal(getFileLoggingStats(), undefined);
    assert.ok(!existsSync(join(dir, "shoggoth-2026-03-01.log")));
  });

  it("degrades to stderr-only when the directory cannot be created", async () => {
    const notADir = join(dir, "file-not-dir");
    writeFileSync(notADir, "x");
    const sink = initFileLogging({ dir: join(notADir, "logs"), now: () => FIXED_NOW });
    assert.equal(sink, undefined);
    assert.equal(getFileLoggingStats(), undefined);

    // Logging still works (stderr only) without throwing.
    const log = createLogger({ component: "itest" });
    assert.doesNotThrow(() => log.info("still fine"));
  });
});
