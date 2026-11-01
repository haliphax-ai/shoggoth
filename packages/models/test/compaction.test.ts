import { describe, it } from "vitest";
import assert from "node:assert";
import {
  estimateTranscriptChars,
  compactTranscriptIfNeeded,
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

describe("compactTranscriptIfNeeded", () => {
  it("always compacts when called with enough messages", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const policy: CompactionPolicy = {
      preserveRecentMessages: 2,
    };
    const client: FailoverModelClient = {
      async complete() {
        return {
          content: "compacted",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };
    const r = await compactTranscriptIfNeeded(messages, policy, client, {});
    assert.equal(r.compacted, true);
    assert.equal(r.messages.length, 3);
    assert.ok((r.messages[0]?.content ?? "").includes("compacted"));
    assert.equal(r.messages[1]?.content, "c");
  });

  it("compacts middle preserving system prefix and tail", async () => {
    const filler = "x".repeat(200);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: filler },
      { role: "assistant", content: filler },
      { role: "user", content: "tail-u" },
      { role: "assistant", content: "tail-a" },
    ];
    const policy: CompactionPolicy = {
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

  it("wraps summary in <summary> tags", async () => {
    const filler = "x".repeat(200);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: filler },
      { role: "assistant", content: filler },
      { role: "user", content: "tail-u" },
    ];
    const policy: CompactionPolicy = {
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
    assert.ok(
      capturedSystem?.includes("## Opaque Identifiers"),
      "should include Opaque Identifiers section",
    );
    assert.ok(
      !capturedSystem?.includes("<previous-summary>"),
      "should NOT include previous-summary block",
    );
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
    assert.ok(
      capturedSystem?.includes("<previous-summary>"),
      "should include previous-summary block",
    );
    assert.ok(
      capturedSystem?.includes("Build the feature"),
      "should include previous summary content",
    );
    assert.ok(
      capturedSystem?.includes("Merge this information with the previous summary"),
      "should include merge instruction",
    );
    assert.ok(
      !capturedSystem?.includes("<summary-template>"),
      "should NOT include summary template when previous exists",
    );
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
    assert.ok(
      !capturedSystem?.includes("<previous-summary>"),
      "should NOT include previous-summary block",
    );
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
    assert.ok(
      capturedSystem?.includes("Preserve all opaque identifiers"),
      "should include opaque identifiers instruction",
    );
    assert.ok(
      capturedSystem?.includes("UUIDs, hashes, IDs, tokens"),
      "should list identifier types",
    );
  });

  it("trims orphaned tool results from the tail boundary", async () => {
    // Repro from issue #568: rest = [assistant(toolCalls=[A]), tool(A), assistant(text), user]
    // with preserveRecentMessages: 3 the raw slice starts at tool(A) and orphans it.
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-A", name: "foo", arguments: "{}" }],
      },
      { role: "tool", content: "result-A", toolCallId: "call-A" },
      { role: "assistant", content: "thinking" },
      { role: "user", content: "next" },
    ];
    const policy: CompactionPolicy = { preserveRecentMessages: 3 };
    const client: FailoverModelClient = {
      async complete() {
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
    // The orphaned tool(A) must be dropped — the tail must not start with a tool message
    // whose toolCallId has no matching assistant toolCalls in the tail.
    const tail = r.messages.slice(1); // skip the summary block
    assert.ok(tail.length >= 1, "tail should have at least one message");
    assert.notEqual(
      tail[0]!.role,
      "tool",
      "first tail message must not be an orphaned tool result",
    );
    // The assistant(text) and user messages should be preserved
    assert.ok(tail.some((m) => m.role === "assistant" && m.content === "thinking"));
    assert.ok(tail.some((m) => m.role === "user" && m.content === "next"));
  });

  it("does not trim tool results that have a matching assistant in the tail", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-B", name: "bar", arguments: "{}" }],
      },
      { role: "tool", content: "result-B", toolCallId: "call-B" },
      { role: "assistant", content: "reply" },
    ];
    const policy: CompactionPolicy = { preserveRecentMessages: 3 };
    const client: FailoverModelClient = {
      async complete() {
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
    const tail = r.messages.slice(1);
    // tool(B) has a matching assistant in the tail, so it must be preserved
    assert.ok(tail.some((m) => m.role === "tool" && m.toolCallId === "call-B"));
  });
});
