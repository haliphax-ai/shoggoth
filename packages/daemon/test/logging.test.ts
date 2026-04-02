import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { createLogger } from "../src/logging";

describe("createLogger", () => {
  let chunks: string[] = [];
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    chunks = [];
    origWrite = process.stderr.write.bind(process.stderr);
    const write = vi.fn((chunk: string | Uint8Array, _enc?: unknown, cb?: () => void) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      cb?.();
      return true;
    });
    process.stderr.write = write as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origWrite;
  });

  it("writes JSON with ts, level, msg, component", () => {
    const log = createLogger({ component: "test", minLevel: "debug" });
    log.info("hello", { x: 1 });
    assert.equal(chunks.length, 1);
    const row = JSON.parse(chunks[0]!.trim()) as Record<string, unknown>;
    assert.equal(row.level, "info");
    assert.equal(row.msg, "hello");
    assert.equal(row.component, "test");
    assert.equal(row.x, 1);
    assert.ok(typeof row.ts === "string");
  });

  it("respects minLevel", () => {
    const log = createLogger({ component: "t", minLevel: "warn" });
    log.info("nope");
    assert.equal(chunks.length, 0);
    log.warn("yep");
    assert.equal(chunks.length, 1);
  });
});
