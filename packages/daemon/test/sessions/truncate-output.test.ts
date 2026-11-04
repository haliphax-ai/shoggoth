import { describe, it } from "vitest";
import assert from "node:assert";
import { truncateToolOutput } from "../../src/sessions/builtin-handlers/truncate-output";

describe("truncateToolOutput", () => {
  it("returns short text unchanged", () => {
    assert.equal(truncateToolOutput("hello"), "hello");
  });

  it("returns text at exactly 50k unchanged", () => {
    const text = "x".repeat(50_000);
    assert.equal(truncateToolOutput(text), text);
  });

  it("truncates text over 50k to first 10k + notice + last 10k", () => {
    const text = "A".repeat(10_000) + "B".repeat(40_001) + "C".repeat(10_000);
    const result = truncateToolOutput(text);
    assert.ok(result.startsWith("A".repeat(10_000)));
    assert.ok(result.includes("[... truncated"));
    assert.ok(result.endsWith("C".repeat(10_000)));
    assert.ok(result.length < text.length);
  });

  it("preserves first and last 10k characters exactly", () => {
    const head = "H".repeat(10_000);
    const tail = "T".repeat(10_000);
    const text = head + "M".repeat(50_000) + tail;
    const result = truncateToolOutput(text);
    assert.equal(result.slice(0, 10_000), head);
    assert.equal(result.slice(-10_000), tail);
  });
});

import { truncateResultJson } from "../../src/sessions/builtin-handlers/truncate-output";

describe("truncateResultJson", () => {
  it("returns small payloads unchanged", () => {
    const payload = JSON.stringify({ ok: true, output: "x".repeat(1_000) });
    assert.equal(truncateResultJson(payload), payload);
  });

  it("returns payloads at exactly the cap unchanged", () => {
    const payload = JSON.stringify({ output: "x".repeat(49_900) });
    assert.ok(payload.length <= 50_000);
    assert.equal(truncateResultJson(payload), payload);
  });

  it("clips oversized string leafs while keeping the payload parseable", () => {
    const big = "y".repeat(60_000);
    const payload = JSON.stringify({ resultJson: big });
    const result = truncateResultJson(payload);
    assert.ok(result.length <= 50_000, `expected clipped, got ${result.length}`);
    const parsed = JSON.parse(result) as { resultJson: string };
    assert.ok(parsed.resultJson.startsWith("y"));
    assert.ok(parsed.resultJson.includes("[... truncated ...]"));
  });

  it("preserves keys and array shape of a structured payload", () => {
    const payload = JSON.stringify({
      messages: [
        { role: "tool", content: "z".repeat(55_000) },
        { role: "user", content: "small" },
      ],
      count: 2,
    });
    const result = truncateResultJson(payload);
    const parsed = JSON.parse(result) as {
      messages: { role: string; content: string }[];
      count: number;
    };
    assert.equal(parsed.count, 2);
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[1]!.content, "small");
    assert.ok(parsed.messages[0]!.content.length < 30_000);
  });

  it("keeps head + notice for a non-JSON oversized result", () => {
    const raw = "w".repeat(60_000);
    const result = truncateResultJson(raw);
    assert.ok(result.startsWith("w"));
    assert.ok(result.includes("[... truncated"));
    assert.ok(result.length < raw.length);
  });

  it("keeps head + notice for oversized unparseable JSON", () => {
    const raw = '{"output":"' + "v".repeat(60_000); // cut mid-string, no close
    const result = truncateResultJson(raw);
    assert.ok(result.startsWith('{"output":"'));
    assert.ok(result.includes("[... truncated"));
    assert.ok(result.length <= 50_000);
  });

  it("stubs a payload that is still too large after per-string clipping", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ [`k${i}`]: "a".repeat(4_000) }));
    const payload = JSON.stringify({ items: many });
    const result = truncateResultJson(payload);
    assert.ok(result.length <= 50_000, `expected stub, got ${result.length}`);
    assert.ok(result.includes("[... truncated"));
  });
});
