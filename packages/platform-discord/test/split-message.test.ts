import { describe, it } from "vitest";
import assert from "node:assert";
import { splitDiscordMessage } from "../src/split-message";

describe("splitDiscordMessage", () => {
  it("returns single-element array for text under maxLength", () => {
    const result = splitDiscordMessage("hello world");
    assert.deepStrictEqual(result, ["hello world"]);
  });

  it("returns single-element array for text exactly at maxLength", () => {
    const text = "a".repeat(2000);
    const result = splitDiscordMessage(text);
    assert.deepStrictEqual(result, [text]);
  });

  it('returns [""] for empty string', () => {
    const result = splitDiscordMessage("");
    assert.deepStrictEqual(result, [""]);
  });

  it("splits at newline boundaries", () => {
    const line = "a".repeat(90) + "\n";
    const text = line.repeat(25); // 25 * 91 = 2275 chars
    const result = splitDiscordMessage(text, 200);
    for (const chunk of result) {
      assert.ok(chunk.length <= 200, `chunk length ${chunk.length} exceeds 200`);
    }
    // Reassembled content should match original
    assert.strictEqual(result.join(""), text);
  });

  it("splits at space boundaries when no newlines available", () => {
    // Build a long string with spaces but no newlines
    const word = "abcdefghij"; // 10 chars
    const text = Array.from({ length: 250 }, () => word).join(" "); // 250*10 + 249 = 2749
    const result = splitDiscordMessage(text, 200);
    for (const chunk of result) {
      assert.ok(chunk.length <= 200, `chunk length ${chunk.length} exceeds 200`);
    }
    // Content preserved (spaces at split points become trailing)
    const joined = result.join("");
    assert.strictEqual(joined, text);
  });

  it("hard-cuts when no whitespace available", () => {
    const text = "a".repeat(500);
    const result = splitDiscordMessage(text, 200);
    for (const chunk of result) {
      assert.ok(chunk.length <= 200, `chunk length ${chunk.length} exceeds 200`);
    }
    assert.strictEqual(result.join(""), text);
  });

  it("closes and reopens fenced code blocks across splits", () => {
    const code = "x".repeat(180);
    const text = `before\n\`\`\`\n${code}\n\`\`\`\nafter`;
    const result = splitDiscordMessage(text, 100);

    // Find the chunk that starts the code block
    const fenceOpeners = result.filter((c) => c.includes("```") && !c.includes("```\n" + "x"));
    // Every chunk should fit
    for (const chunk of result) {
      assert.ok(chunk.length <= 100, `chunk length ${chunk.length} exceeds 100`);
    }

    // At least one chunk should end with ``` (closing a split code block)
    const hasClosingFence = result.some(
      (c, i) => i < result.length - 1 && c.trimEnd().endsWith("```"),
    );
    // At least one non-first chunk should start with ``` (reopening)
    const hasReopeningFence = result.some(
      (c, i) => i > 0 && c.startsWith("```"),
    );
    assert.ok(hasClosingFence || result.length === 1, "expected a closing fence on a split chunk");
    assert.ok(hasReopeningFence || result.length === 1, "expected a reopening fence on a continuation chunk");
  });

  it("preserves language tag on fenced code block reopen", () => {
    const code = "y".repeat(180);
    const text = `\`\`\`typescript\n${code}\n\`\`\``;
    const result = splitDiscordMessage(text, 100);

    // Non-first chunks that reopen should include the language tag
    const continuations = result.slice(1).filter((c) => c.startsWith("```"));
    for (const c of continuations) {
      assert.ok(
        c.startsWith("```typescript\n"),
        `expected continuation to start with \`\`\`typescript, got: ${c.slice(0, 30)}`,
      );
    }
  });

  it("closes and reopens inline formatting across splits", () => {
    // Bold text that spans across a split boundary
    const inner = "w".repeat(180);
    const text = `**${inner}**`;
    const result = splitDiscordMessage(text, 100);

    assert.ok(result.length > 1, "expected multiple chunks");
    // First chunk should close the bold
    assert.ok(result[0].endsWith("**"), "first chunk should close bold");
    // Second chunk should reopen bold
    assert.ok(result[1].startsWith("**"), "second chunk should reopen bold");

    for (const chunk of result) {
      assert.ok(chunk.length <= 100, `chunk length ${chunk.length} exceeds 100`);
    }
  });

  it("handles strikethrough across splits", () => {
    const inner = "z".repeat(180);
    const text = `~~${inner}~~`;
    const result = splitDiscordMessage(text, 100);
    assert.ok(result.length > 1);
    assert.ok(result[0].endsWith("~~"), "first chunk should close strikethrough");
    assert.ok(result[1].startsWith("~~"), "second chunk should reopen strikethrough");
  });

  it("handles spoiler across splits", () => {
    const inner = "s".repeat(180);
    const text = `||${inner}||`;
    const result = splitDiscordMessage(text, 100);
    assert.ok(result.length > 1);
    assert.ok(result[0].endsWith("||"), "first chunk should close spoiler");
    assert.ok(result[1].startsWith("||"), "second chunk should reopen spoiler");
  });

  it("all chunks fit within maxLength", () => {
    // Stress test with mixed content
    const text = Array.from({ length: 100 }, (_, i) =>
      i % 5 === 0 ? `\`\`\`js\nconsole.log(${i});\n\`\`\`\n` : `Line ${i}: ${"x".repeat(40)}\n`,
    ).join("");
    const result = splitDiscordMessage(text, 300);
    for (const chunk of result) {
      assert.ok(chunk.length <= 300, `chunk length ${chunk.length} exceeds 300`);
    }
  });
});
