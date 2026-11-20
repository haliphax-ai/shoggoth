import { describe, it } from "vitest";
import assert from "node:assert";
import {
  normalizeThinkingBlocks,
  extractXmlThinkingBlocks,
  stripXmlThinkingTags,
} from "../src/thinking-normalize";
import type { ChatContentPart } from "../src/types";

describe("extractXmlThinkingBlocks", () => {
  it("returns original string when no thinking tags present", () => {
    const content = "This is just regular text with no thinking blocks.";
    const result = extractXmlThinkingBlocks(content);
    assert.strictEqual(result, content);
    assert.strictEqual(typeof result, "string");
  });

  it("extracts single thinking block", () => {
    const content = "Before <thinking>This is my reasoning</thinking> After";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "text", text: "Before" },
      { type: "thinking", text: "This is my reasoning" },
      { type: "text", text: "After" },
    ]);
  });

  it("extracts multiple thinking blocks", () => {
    const content =
      "Start <thinking>First thought</thinking> middle <thinking>Second thought</thinking> end";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "text", text: "Start" },
      { type: "thinking", text: "First thought" },
      { type: "text", text: "middle" },
      { type: "thinking", text: "Second thought" },
      { type: "text", text: "end" },
    ]);
  });

  it("handles thinking block at start of content", () => {
    const content = "<thinking>Initial reasoning</thinking> then text";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "thinking", text: "Initial reasoning" },
      { type: "text", text: "then text" },
    ]);
  });

  it("handles thinking block at end of content", () => {
    const content = "Text first <thinking>Final reasoning</thinking>";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "text", text: "Text first" },
      { type: "thinking", text: "Final reasoning" },
    ]);
  });

  it("handles only thinking block (no surrounding text)", () => {
    const content = "<thinking>Just thinking</thinking>";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [{ type: "thinking", text: "Just thinking" }]);
  });

  it("handles empty thinking block (skipped, creates separate text parts)", () => {
    const content = "Text <thinking></thinking> more text";
    const result = extractXmlThinkingBlocks(content);
    // Empty thinking blocks are skipped, but text parts remain separate
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "text", text: "Text" },
      { type: "text", text: "more text" },
    ]);
  });

  it("handles nested thinking tags (first closing tag ends outer)", () => {
    const content = "Start <thinking>Outer <thinking>inner</thinking> text</thinking> end";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    // Non-greedy matching: first </thinking> closes the outer tag
    // So we get: Start | Outer <thinking>inner | text</thinking> end
    assert.deepStrictEqual(result, [
      { type: "text", text: "Start" },
      { type: "thinking", text: "Outer <thinking>inner" },
      { type: "text", text: "text</thinking> end" },
    ]);
  });

  it("handles unclosed thinking tag (no match, returns original)", () => {
    const content = "Text <thinking>Unclosed thinking content";
    const result = extractXmlThinkingBlocks(content);
    // Unclosed tags don't match the regex, so original string is returned
    assert.strictEqual(result, content);
  });

  it("handles multiline thinking content", () => {
    const content = `Before <thinking>
Line 1 of reasoning
Line 2 of reasoning
Line 3 of reasoning
</thinking> After`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts.length, 3);
    assert.strictEqual(parts[0].type, "text");
    assert.strictEqual((parts[0] as { type: "text"; text: string }).text, "Before");
    assert.strictEqual(parts[1].type, "thinking");
    assert((parts[1] as { type: "thinking"; text: string }).text.includes("Line 1"));
    assert((parts[1] as { type: "thinking"; text: string }).text.includes("Line 3"));
    assert.strictEqual(parts[2].type, "text");
    assert.strictEqual((parts[2] as { type: "text"; text: string }).text, "After");
  });

  it("trims whitespace from extracted parts", () => {
    const content = "  Text  <thinking>  Thinking  </thinking>  More  ";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "text", text: "Text" },
      { type: "thinking", text: "Thinking" },
      { type: "text", text: "More" },
    ]);
  });

  it("handles consecutive thinking blocks", () => {
    const content = "<thinking>First</thinking><thinking>Second</thinking>";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "thinking", text: "First" },
      { type: "thinking", text: "Second" },
    ]);
  });

  it("handles thinking blocks with special characters", () => {
    const content = `<thinking>Special chars: !@#$%^&*()_+-=[]{}|;':",./<>?</thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    assert((parts[0] as { type: "thinking"; text: string }).text.includes("!@#$%^&*"));
  });

  it("handles thinking blocks with XML-like content", () => {
    const content = `<thinking>Check the <tool_call> structure</thinking> Response`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "thinking", text: "Check the <tool_call> structure" },
      { type: "text", text: "Response" },
    ]);
  });

  it("returns string when result is single text part", () => {
    const content = "Just text, no thinking";
    const result = extractXmlThinkingBlocks(content);
    assert.strictEqual(result, content);
    assert.strictEqual(typeof result, "string");
  });

  it("handles mixed content with tool calls", () => {
    const content = `<thinking>I need to call a tool</thinking>
<tool_call>
  <name>search</name>
  <input>query</input>
</tool_call>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    assert.strictEqual(parts[1].type, "text");
    assert((parts[1] as { type: "text"; text: string }).text.includes("<tool_call>"));
  });

  it("handles case-sensitive tag matching", () => {
    const content = "Text <THINKING>uppercase</THINKING> more";
    const result = extractXmlThinkingBlocks(content);
    // Should not match uppercase tags
    assert.strictEqual(result, content);
  });

  it("handles thinking tags with attributes (should not match)", () => {
    const content = 'Text <thinking type="deep">content</thinking> more';
    const result = extractXmlThinkingBlocks(content);
    // Should not match tags with attributes
    assert.strictEqual(result, content);
  });

  it("handles very long thinking content", () => {
    const longThinking = "x".repeat(10000);
    const content = `Before <thinking>${longThinking}</thinking> After`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[1].type, "thinking");
    assert.strictEqual((parts[1] as { type: "thinking"; text: string }).text.length, 10000);
  });

  it("handles multiple empty thinking blocks (creates separate text parts)", () => {
    const content = "Text <thinking></thinking> middle <thinking></thinking> end";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    // Empty blocks are skipped, leaving separate text parts
    assert.deepStrictEqual(result, [
      { type: "text", text: "Text" },
      { type: "text", text: "middle" },
      { type: "text", text: "end" },
    ]);
  });

  it("handles thinking block followed immediately by another", () => {
    const content = "Start<thinking>A</thinking><thinking>B</thinking>End";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts.length, 4);
    assert.strictEqual((parts[0] as { type: "text"; text: string }).text, "Start");
    assert.strictEqual((parts[1] as { type: "thinking"; text: string }).text, "A");
    assert.strictEqual((parts[2] as { type: "thinking"; text: string }).text, "B");
    assert.strictEqual((parts[3] as { type: "text"; text: string }).text, "End");
  });
});

describe("normalizeThinkingBlocks", () => {
  it("returns content unchanged when format is 'none'", () => {
    const content = "Text <thinking>reasoning</thinking> more";
    const result = normalizeThinkingBlocks(content, "none");
    assert.strictEqual(result, content);
  });

  it("returns content unchanged when format is 'native'", () => {
    const content = "Text with native thinking already handled";
    const result = normalizeThinkingBlocks(content, "native");
    assert.strictEqual(result, content);
  });

  it("extracts thinking blocks when format is 'xml-tags'", () => {
    const content = "Before <thinking>reasoning</thinking> after";
    const result = normalizeThinkingBlocks(content, "xml-tags");
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "text", text: "Before" },
      { type: "thinking", text: "reasoning" },
      { type: "text", text: "after" },
    ]);
  });

  it("returns string when xml-tags format finds no tags", () => {
    const content = "Just regular text";
    const result = normalizeThinkingBlocks(content, "xml-tags");
    assert.strictEqual(result, content);
    assert.strictEqual(typeof result, "string");
  });

  it("handles multiple thinking blocks with xml-tags format", () => {
    const content = "<thinking>First</thinking> text <thinking>Second</thinking>";
    const result = normalizeThinkingBlocks(content, "xml-tags");
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "thinking", text: "First" },
      { type: "text", text: "text" },
      { type: "thinking", text: "Second" },
    ]);
  });

  it("handles empty thinking blocks with xml-tags format", () => {
    const content = "Text <thinking></thinking> more";
    const result = normalizeThinkingBlocks(content, "xml-tags");
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "text", text: "Text" },
      { type: "text", text: "more" },
    ]);
  });

  it("handles unclosed thinking tags with xml-tags format (no match)", () => {
    const content = "Text <thinking>unclosed";
    const result = normalizeThinkingBlocks(content, "xml-tags");
    // Unclosed tags don't match, so original string is returned
    assert.strictEqual(result, content);
  });

  it("preserves content exactly when format is 'native'", () => {
    const content = "This is native thinking format content";
    const result = normalizeThinkingBlocks(content, "native");
    assert.strictEqual(result, content);
  });

  it("preserves content exactly when format is 'none'", () => {
    const content = "This model doesn't produce thinking";
    const result = normalizeThinkingBlocks(content, "none");
    assert.strictEqual(result, content);
  });

  it("handles undefined format (treated as none)", () => {
    const content = "Text <thinking>reasoning</thinking> more";
    const result = normalizeThinkingBlocks(content, undefined);
    assert.strictEqual(result, content);
  });
});

describe("thinking normalization edge cases", () => {
  it("handles thinking block with only whitespace (skipped)", () => {
    const content = "Text <thinking>   \n\t  </thinking> more";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    // Whitespace-only thinking blocks are skipped
    assert.deepStrictEqual(result, [
      { type: "text", text: "Text" },
      { type: "text", text: "more" },
    ]);
  });

  it("handles malformed closing tag (missing >)", () => {
    const content = "Text <thinking>content</thinking more";
    const result = extractXmlThinkingBlocks(content);
    // Should not match malformed closing tag
    assert.strictEqual(result, content);
  });

  it("handles thinking tags in tool results (extracts anyway)", () => {
    // Note: The plan says "don't extract" for tool results, but extraction
    // happens at the adapter level before we know the context. The adapter
    // should handle this by not calling normalization for tool results.
    // This test documents that the extraction function itself doesn't
    // discriminate based on context.
    const toolResult = `<tool_result>
<thinking>Processing the result</thinking>
The actual result data
</tool_result>`;
    const result = extractXmlThinkingBlocks(toolResult);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert(parts.some((p) => p.type === "thinking"));
  });

  it("handles very deeply nested structures", () => {
    const content = `<thinking>
{
  "nested": {
    "deeply": {
      "structure": {
        "with": {
          "many": {
            "levels": "value"
          }
        }
      }
    }
  }
}
</thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    assert((parts[0] as { type: "thinking"; text: string }).text.includes('"nested"'));
  });

  it("handles thinking blocks with escaped characters", () => {
    const content = `<thinking>Escaped: \\n \\t \\\\ \\"</thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    assert((parts[0] as { type: "thinking"; text: string }).text.includes("\\"));
  });

  it("handles unicode content in thinking blocks", () => {
    const content = `<thinking>Unicode: 你好 مرحبا שלום 🤔</thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    assert((parts[0] as { type: "thinking"; text: string }).text.includes("你好"));
    assert((parts[0] as { type: "thinking"; text: string }).text.includes("🤔"));
  });

  it("handles thinking blocks with HTML entities", () => {
    const content = `<thinking>HTML: &lt;tag&gt; &amp; &quot;</thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    assert((parts[0] as { type: "thinking"; text: string }).text.includes("&lt;"));
  });

  it("handles regex special characters in content", () => {
    const content = `<thinking>Regex: . * + ? [ ] ( ) { } ^ $ |</thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    const text = (parts[0] as { type: "thinking"; text: string }).text;
    assert(text.includes("."));
    assert(text.includes("*"));
    assert(text.includes("+"));
    assert(text.includes("?"));
  });

  it("handles thinking blocks with CDATA-like content", () => {
    const content = `<thinking><![CDATA[This looks like CDATA]]></thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    assert((parts[0] as { type: "thinking"; text: string }).text.includes("CDATA"));
  });

  it("handles alternating thinking and text blocks", () => {
    const content = `<thinking>A</thinking>text1<thinking>B</thinking>text2<thinking>C</thinking>text3`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts.length, 6);
    assert.strictEqual(parts[0].type, "thinking");
    assert.strictEqual(parts[1].type, "text");
    assert.strictEqual(parts[2].type, "thinking");
    assert.strictEqual(parts[3].type, "text");
    assert.strictEqual(parts[4].type, "thinking");
    assert.strictEqual(parts[5].type, "text");
  });

  it("handles thinking block with newlines and indentation", () => {
    const content = `<thinking>
    Indented thinking
    with multiple lines
    and structure
</thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts[0].type, "thinking");
    assert((parts[0] as { type: "thinking"; text: string }).text.includes("Indented"));
  });

  it("handles single thinking block returns as array not string", () => {
    const content = `<thinking>Only thinking</thinking>`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [{ type: "thinking", text: "Only thinking" }]);
  });

  it("handles text before and after multiple thinking blocks", () => {
    const content = `Start <thinking>A</thinking> middle <thinking>B</thinking> end`;
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    const parts = result as ChatContentPart[];
    assert.strictEqual(parts.length, 5);
    assert.strictEqual((parts[0] as { type: "text"; text: string }).text, "Start");
    assert.strictEqual((parts[1] as { type: "thinking"; text: string }).text, "A");
    assert.strictEqual((parts[2] as { type: "text"; text: string }).text, "middle");
    assert.strictEqual((parts[3] as { type: "thinking"; text: string }).text, "B");
    assert.strictEqual((parts[4] as { type: "text"; text: string }).text, "end");
  });
});

describe("Gemma-style <think> tag support", () => {
  it("extracts <think> blocks the same as <thinking>", () => {
    const content = "Before <think>Gemma reasoning</think> After";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "text", text: "Before" },
      { type: "thinking", text: "Gemma reasoning" },
      { type: "text", text: "After" },
    ]);
  });

  it("handles mixed <think> and <thinking> tags", () => {
    const content = "<think>Gemma style</think> text <thinking>Standard style</thinking>";
    const result = extractXmlThinkingBlocks(content);
    assert(Array.isArray(result));
    assert.deepStrictEqual(result, [
      { type: "thinking", text: "Gemma style" },
      { type: "text", text: "text" },
      { type: "thinking", text: "Standard style" },
    ]);
  });
});

describe("stripXmlThinkingTags", () => {
  it("strips thinking tags from a string and returns only text", () => {
    assert.strictEqual(
      stripXmlThinkingTags("<thinking>reasoning here</thinking>actual content"),
      "actual content",
    );
  });

  it("strips think tags (Gemma-style)", () => {
    assert.strictEqual(
      stripXmlThinkingTags("<think>reasoning</think>actual content"),
      "actual content",
    );
  });

  it("returns original string when no thinking tags present", () => {
    const s = '{"file":"test.ts","match":"foo"}';
    assert.strictEqual(stripXmlThinkingTags(s), s);
  });

  it("strips thinking tags from tool call argument JSON", () => {
    const dirty =
      '<thinking>Let me figure out the args</thinking>{"file":"test.ts","match":"foo","replacement":"bar"}';
    assert.strictEqual(
      stripXmlThinkingTags(dirty),
      '{"file":"test.ts","match":"foo","replacement":"bar"}',
    );
  });

  it("strips thinking tags embedded mid-argument", () => {
    const dirty = '{"file":"test.ts",<thinking>I need to set match</thinking>"match":"foo"}';
    assert.strictEqual(stripXmlThinkingTags(dirty), '{"file":"test.ts","match":"foo"}');
  });

  it("strips multiple thinking blocks from arguments", () => {
    const dirty =
      '<thinking>first thought</thinking>{"key":<thinking>second thought</thinking>"value"}';
    assert.strictEqual(stripXmlThinkingTags(dirty), '{"key":"value"}');
  });

  it("strips multiline thinking blocks from arguments", () => {
    const dirty = `<thinking>
Let me analyze this carefully.
The file needs to be updated.
</thinking>{"file":"src/index.ts"}`;
    assert.strictEqual(stripXmlThinkingTags(dirty), '{"file":"src/index.ts"}');
  });

  it("handles empty string", () => {
    assert.strictEqual(stripXmlThinkingTags(""), "");
  });

  it("handles string that is only a thinking block", () => {
    assert.strictEqual(stripXmlThinkingTags("<thinking>all thinking no content</thinking>"), "");
  });
});
