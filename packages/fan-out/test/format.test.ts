import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../src/format.js";

describe("formatDuration", () => {
  it("formats zero as 0s", () => {
    assert.equal(formatDuration(0), "0s");
  });

  it("formats sub-second as 0s", () => {
    assert.equal(formatDuration(500), "0s");
  });

  it("formats seconds under 60s", () => {
    assert.equal(formatDuration(1_000), "1s");
    assert.equal(formatDuration(20_000), "20s");
    assert.equal(formatDuration(59_000), "59s");
  });

  it("formats minutes and seconds under 60m", () => {
    assert.equal(formatDuration(60_000), "1m0s");
    assert.equal(formatDuration(65_000), "1m5s");
    assert.equal(formatDuration(37 * 60_000 + 42_000), "37m42s");
    assert.equal(formatDuration(59 * 60_000 + 59_000), "59m59s");
  });

  it("formats hours and minutes at 60m+", () => {
    assert.equal(formatDuration(60 * 60_000), "1h0m");
    assert.equal(formatDuration(63 * 60_000), "1h3m");
    assert.equal(formatDuration(2 * 3600_000 + 15 * 60_000), "2h15m");
  });

  it("truncates partial seconds", () => {
    assert.equal(formatDuration(20_999), "20s");
  });

  it("truncates partial minutes in hour range", () => {
    assert.equal(formatDuration(3600_000 + 30_000), "1h0m");
  });
});
