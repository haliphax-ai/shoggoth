import { describe, it, expect } from "vitest";
import {
  parseReactionLegend,
  routeReaction,
  type ReactionRouteInput,
} from "../../src/presentation/reaction-router";

describe("parseReactionLegend", () => {
  it("returns null when no legend header is present", () => {
    expect(parseReactionLegend("just a normal message")).toBeNull();
  });

  it("parses a simple legend block", () => {
    const content = `Some text\nReact to choose:\n👍 Approve\n👎 Reject\n\nMore text`;
    const legend = parseReactionLegend(content);
    expect(legend).not.toBeNull();
    expect(legend!.entries).toEqual([
      { emoji: "👍", label: "Approve" },
      { emoji: "👎", label: "Reject" },
    ]);
  });

  it("handles emoji-only entries (no label)", () => {
    const content = `React to choose:\n🔥\n`;
    const legend = parseReactionLegend(content);
    expect(legend).not.toBeNull();
    expect(legend!.entries).toEqual([{ emoji: "🔥", label: "" }]);
  });

  it("stops at blank line", () => {
    const content = `React to choose:\n✅ Yes\n\n❌ No`;
    const legend = parseReactionLegend(content);
    expect(legend!.entries).toHaveLength(1);
    expect(legend!.entries[0]).toEqual({ emoji: "✅", label: "Yes" });
  });

  it("returns null when header exists but no entries follow", () => {
    const content = `React to choose:\n\nNothing here`;
    expect(parseReactionLegend(content)).toBeNull();
  });

  it("is case-insensitive for the header", () => {
    const content = `REACT TO CHOOSE:\n🎉 Party`;
    const legend = parseReactionLegend(content);
    expect(legend).not.toBeNull();
    expect(legend!.entries[0]!.label).toBe("Party");
  });
});

describe("routeReaction", () => {
  const base: ReactionRouteInput = {
    emoji: "👍",
    messageContent: "hello",
    messageTimestamp: Date.now(),
    nowMs: Date.now(),
    maxAgeMinutes: 30,
    globalPassthrough: ["👍", "👎"],
  };

  it("discards when message is too old", () => {
    const result = routeReaction({
      ...base,
      messageTimestamp: Date.now() - 60 * 60_000, // 60 minutes ago
      nowMs: Date.now(),
      maxAgeMinutes: 30,
    });
    expect(result.kind).toBe("discard");
    if (result.kind === "discard") {
      expect(result.reason).toContain("too old");
    }
  });

  it("returns adhoc when legend matches", () => {
    const content = "Some text\nReact to choose:\n👍 Approve\n👎 Reject\n\nMore text";
    const now = Date.now();
    const result = routeReaction({
      ...base,
      messageContent: content,
      messageTimestamp: now - 1000,
      nowMs: now,
    });
    expect(result.kind).toBe("adhoc");
    if (result.kind === "adhoc") {
      expect(result.selected.emoji).toBe("👍");
      expect(result.selected.label).toBe("Approve");
    }
  });

  it("discards when legend exists but emoji not in legend", () => {
    const content = "Some text\nReact to choose:\n✅ Yes\n❌ No\n\nMore text";
    const now = Date.now();
    const result = routeReaction({
      ...base,
      emoji: "🔥",
      messageContent: content,
      messageTimestamp: now - 1000,
      nowMs: now,
    });
    expect(result.kind).toBe("discard");
    if (result.kind === "discard") {
      expect(result.reason).toContain("not in legend");
    }
  });

  it("returns global when no legend and emoji in passthrough", () => {
    const now = Date.now();
    const result = routeReaction({
      ...base,
      messageContent: "no legend here",
      messageTimestamp: now - 1000,
      nowMs: now,
    });
    expect(result.kind).toBe("global");
    if (result.kind === "global") {
      expect(result.emoji).toBe("👍");
    }
  });

  it("discards when no legend and emoji not in passthrough", () => {
    const now = Date.now();
    const result = routeReaction({
      ...base,
      emoji: "🔥",
      messageContent: "no legend here",
      messageTimestamp: now - 1000,
      nowMs: now,
      globalPassthrough: ["👍"],
    });
    expect(result.kind).toBe("discard");
    if (result.kind === "discard") {
      expect(result.reason).toContain("not in global passthrough");
    }
  });
});
