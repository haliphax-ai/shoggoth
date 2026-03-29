import { describe, it } from "node:test";
import assert from "node:assert";
import {
  estimateTranscriptChars,
  compactTranscriptIfNeeded,
  shouldAutoCompact,
  type CompactionPolicy,
} from "../src/compaction";
import type { ChatMessage } from "../src/types";
import type { FailoverModelClient } from "../src/failover";

describe("estimateTranscriptChars", () => {
  it("sums content lengths", () => {
    const m: ChatMessage[] = [
      { role: "user", content: "ab" },
      { role: "assistant", content: "cde" },
    ];
    assert.equal(estimateTranscriptChars(m), 5);
  });
});

describe("shouldAutoCompact", () => {
  it("is true when over maxContextChars", () => {
    assert.equal(
      shouldAutoCompact([{ role: "user", content: "abc" }], { maxContextChars: 2 }),
      true,
    );
  });
});

describe("compactTranscriptIfNeeded", () => {
  it("returns unchanged when under threshold and not forced", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "short" },
      { role: "assistant", content: "ok" },
    ];
    const policy: CompactionPolicy = {
      maxContextChars: 1000,
      preserveRecentMessages: 2,
    };
    let calls = 0;
    const client: FailoverModelClient = {
      async complete() {
        calls++;
        return {
          content: "summary",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    const r = await compactTranscriptIfNeeded(messages, policy, client, {});
    assert.equal(r.compacted, false);
    assert.equal(calls, 0);
    assert.deepEqual(r.messages, messages);
  });

  it("compacts middle when over threshold", async () => {
    const filler = "x".repeat(200);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: filler },
      { role: "assistant", content: filler },
      { role: "user", content: "tail-u" },
      { role: "assistant", content: "tail-a" },
    ];
    const policy: CompactionPolicy = {
      maxContextChars: 100,
      preserveRecentMessages: 2,
    };
    const client: FailoverModelClient = {
      async complete(input) {
        assert.ok(input.messages.some((m) => (m.content ?? "").includes(filler)));
        return {
          content: "SUMMARY",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    const r = await compactTranscriptIfNeeded(messages, policy, client, {});
    assert.equal(r.compacted, true);
    assert.equal(r.messages[0]?.role, "system");
    assert.equal(r.messages[1]?.role, "assistant");
    assert.ok((r.messages[1]?.content ?? "").includes("SUMMARY"));
    assert.equal(r.messages[2]?.content, "tail-u");
    assert.equal(r.messages[3]?.content, "tail-a");
  });

  it("forces compaction when under threshold if force option set", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const policy: CompactionPolicy = {
      maxContextChars: 9999,
      preserveRecentMessages: 2,
    };
    const client: FailoverModelClient = {
      async complete() {
        return {
          content: "forced",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    const r = await compactTranscriptIfNeeded(messages, policy, client, {
      force: true,
    });
    assert.equal(r.compacted, true);
    assert.equal(r.messages.length, 3);
    assert.ok((r.messages[0]?.content ?? "").includes("forced"));
    assert.equal(r.messages[1]?.content, "c");
  });
});
