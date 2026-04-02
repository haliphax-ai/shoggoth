import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@shoggoth/models";
import {
  buildMinimalContextMessages,
  formatGlobalReactionEventContext,
  formatAdhocReactionEventContext,
} from "../../src/presentation/minimal-context";

describe("buildMinimalContextMessages", () => {
  const transcript: ChatMessage[] = [
    { role: "user", content: "msg1" },
    { role: "assistant", content: "msg2" },
    { role: "user", content: "msg3" },
    { role: "assistant", content: "msg4" },
  ];

  it("returns system + tail + event message", () => {
    const result = buildMinimalContextMessages({
      systemPrompt: "You are helpful.",
      fullTranscript: transcript,
      tailMessages: 2,
      eventContext: "reaction event",
    });
    expect(result).toHaveLength(4); // system + 2 tail + event
    expect(result[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(result[1]).toEqual({ role: "user", content: "msg3" });
    expect(result[2]).toEqual({ role: "assistant", content: "msg4" });
    expect(result[3]).toEqual({ role: "user", content: "reaction event" });
  });

  it("returns system + event when tailMessages is 0", () => {
    const result = buildMinimalContextMessages({
      systemPrompt: "sys",
      fullTranscript: transcript,
      tailMessages: 0,
      eventContext: "ev",
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("system");
    expect(result[1]!.role).toBe("user");
  });

  it("handles tailMessages larger than transcript", () => {
    const result = buildMinimalContextMessages({
      systemPrompt: "sys",
      fullTranscript: transcript,
      tailMessages: 100,
      eventContext: "ev",
    });
    // system + all 4 transcript + event
    expect(result).toHaveLength(6);
  });
});

describe("formatGlobalReactionEventContext", () => {
  it("formats a global reaction event", () => {
    const result = formatGlobalReactionEventContext("👍", "some message");
    expect(result).toContain("👍");
    expect(result).toContain("some message");
    expect(result).toContain("Operator reacted");
  });

  it("truncates long message content at 500 chars", () => {
    const long = "x".repeat(600);
    const result = formatGlobalReactionEventContext("👍", long);
    expect(result).toContain("…");
    // The truncated content should be 500 chars + ellipsis
    expect(result.length).toBeLessThan(600);
  });
});

describe("formatAdhocReactionEventContext", () => {
  const legend = [
    { emoji: "✅", label: "Approve" },
    { emoji: "❌", label: "Reject" },
  ];

  it("formats an adhoc reaction with legend", () => {
    const result = formatAdhocReactionEventContext("✅", legend, "choose one");
    expect(result).toContain("✅ Approve ← selected");
    expect(result).toContain("❌ Reject");
    expect(result).toContain("choose one");
    expect(result).toContain("reaction legend");
  });

  it("marks only the selected entry", () => {
    const result = formatAdhocReactionEventContext("❌", legend, "msg");
    expect(result).toContain("❌ Reject ← selected");
    expect(result).not.toContain("✅ Approve ← selected");
  });

  it("truncates long message content", () => {
    const long = "y".repeat(600);
    const result = formatAdhocReactionEventContext("✅", legend, long);
    expect(result).toContain("…");
  });
});
