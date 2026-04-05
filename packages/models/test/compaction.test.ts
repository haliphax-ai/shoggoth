import { describe, it } from "vitest";
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

  it("wraps summary in <summary> tags", async () => {
    const filler = "x".repeat(200);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: filler },
      { role: "assistant", content: filler },
      { role: "user", content: "tail-u" },
    ];
    const policy: CompactionPolicy = {
      maxContextChars: 100,
      preserveRecentMessages: 1,
    };
    const client: FailoverModelClient = {
      async complete() {
        return {
          content: "SUMMARY TEXT",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    const r = await compactTranscriptIfNeeded(messages, policy, client, {});
    assert.equal(r.compacted, true);
    assert.equal(r.messages[1]?.role, "assistant");
    const content = r.messages[1]?.content ?? "";
    assert.ok(content.startsWith("<summary>\n"), "should start with <summary>");
    assert.ok(content.includes("SUMMARY TEXT"), "should include summary content");
    assert.ok(content.endsWith("\n</summary>"), "should end with </summary>");
  });

  it("includes summary template when no previous summary exists", async () => {
    const filler = "x".repeat(200);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: filler },
      { role: "assistant", content: filler },
      { role: "user", content: "tail-u" },
    ];
    const policy: CompactionPolicy = {
      maxContextChars: 100,
      preserveRecentMessages: 1,
    };
    let capturedSystem: string | undefined;
    let capturedUser: string | undefined;
    const client: FailoverModelClient = {
      async complete(input) {
        const sysMsg = input.messages.find((m) => m.role === "system");
        const userMsg = input.messages.find((m) => m.role === "user");
        capturedSystem = sysMsg?.content ?? "";
        capturedUser = userMsg?.content ?? "";
        return {
          content: "SUMMARY",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    await compactTranscriptIfNeeded(messages, policy, client, {});
    assert.ok(capturedSystem?.includes("<summary-template>"), "should include summary template");
    assert.ok(capturedSystem?.includes("## Goal"), "should include Goal section");
    assert.ok(capturedSystem?.includes("## Progress"), "should include Progress section");
    assert.ok(capturedSystem?.includes("## Key Decisions"), "should include Key Decisions section");
    assert.ok(capturedSystem?.includes("## Opaque Identifiers"), "should include Opaque Identifiers section");
    assert.ok(!capturedSystem?.includes("<previous-summary>"), "should NOT include previous-summary block");
    assert.ok(capturedUser?.includes("<conversation>"), "should wrap excerpt in conversation tags");
  });

  it("includes previous summary when first assistant message has <summary> block", async () => {
    const filler = "x".repeat(200);
    const previousSummary = `<summary>
# Compaction Summary

## Goal
Build the feature

## Progress
### Done
- Initial setup
</summary>`;
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: previousSummary },
      { role: "user", content: filler },
      { role: "assistant", content: filler },
      { role: "user", content: "tail-u" },
    ];
    const policy: CompactionPolicy = {
      maxContextChars: 100,
      preserveRecentMessages: 1,
    };
    let capturedSystem: string | undefined;
    const client: FailoverModelClient = {
      async complete(input) {
        const sysMsg = input.messages.find((m) => m.role === "system");
        capturedSystem = sysMsg?.content ?? "";
        return {
          content: "UPDATED SUMMARY",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    await compactTranscriptIfNeeded(messages, policy, client, {});
    assert.ok(capturedSystem?.includes("<previous-summary>"), "should include previous-summary block");
    assert.ok(capturedSystem?.includes("Build the feature"), "should include previous summary content");
    assert.ok(capturedSystem?.includes("Merge this information with the previous summary"), "should include merge instruction");
    assert.ok(!capturedSystem?.includes("<summary-template>"), "should NOT include summary template when previous exists");
  });

  it("does not include previous summary when first assistant message lacks <summary> block", async () => {
    const filler = "x".repeat(200);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "regular response without summary" },
      { role: "user", content: filler },
      { role: "assistant", content: filler },
      { role: "user", content: "tail-u" },
    ];
    const policy: CompactionPolicy = {
      maxContextChars: 100,
      preserveRecentMessages: 1,
    };
    let capturedSystem: string | undefined;
    const client: FailoverModelClient = {
      async complete(input) {
        const sysMsg = input.messages.find((m) => m.role === "system");
        capturedSystem = sysMsg?.content ?? "";
        return {
          content: "SUMMARY",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    await compactTranscriptIfNeeded(messages, policy, client, {});
    assert.ok(!capturedSystem?.includes("<previous-summary>"), "should NOT include previous-summary block");
    assert.ok(capturedSystem?.includes("<summary-template>"), "should include summary template");
  });

  it("preserves opaque identifiers instruction in system prompt", async () => {
    const filler = "x".repeat(200);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: filler },
      { role: "assistant", content: filler },
      { role: "user", content: "tail-u" },
    ];
    const policy: CompactionPolicy = {
      maxContextChars: 100,
      preserveRecentMessages: 1,
    };
    let capturedSystem: string | undefined;
    const client: FailoverModelClient = {
      async complete(input) {
        const sysMsg = input.messages.find((m) => m.role === "system");
        capturedSystem = sysMsg?.content ?? "";
        return {
          content: "SUMMARY",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    await compactTranscriptIfNeeded(messages, policy, client, {});
    assert.ok(capturedSystem?.includes("Preserve all opaque identifiers"), "should include opaque identifiers instruction");
    assert.ok(capturedSystem?.includes("UUIDs, hashes, IDs, tokens"), "should list identifier types");
  });
});