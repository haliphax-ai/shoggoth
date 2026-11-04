import { describe, it } from "vitest";
import assert from "node:assert";
import { dropMcpStructuredContent } from "../../src/mcp/mcp-server-pool";

describe("dropMcpStructuredContent", () => {
  it("drops the content duplicate when structuredContent is present", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ rows: [1, 2, 3] }) }],
      structuredContent: { rows: [1, 2, 3] },
      isError: false,
    };
    const out = dropMcpStructuredContent(result) as Record<string, unknown>;
    assert.ok(!("content" in out));
    assert.deepEqual(out.structuredContent, { rows: [1, 2, 3] });
    assert.equal(out.isError, false);
  });

  it("returns text-only results unchanged", () => {
    const result = { content: [{ type: "text", text: "plain" }] };
    assert.deepEqual(dropMcpStructuredContent(result), result);
  });

  it("returns results without structuredContent unchanged", () => {
    const result = { content: [{ type: "text", text: "x" }], isError: true };
    assert.deepEqual(dropMcpStructuredContent(result), result);
  });

  it("returns null structuredContent unchanged (treats as absent)", () => {
    const result = { content: [{ type: "text", text: "x" }], structuredContent: null };
    assert.deepEqual(dropMcpStructuredContent(result), result);
  });

  it("returns non-object results unchanged", () => {
    assert.equal(dropMcpStructuredContent("plain string"), "plain string");
    assert.equal(dropMcpStructuredContent(null), null);
    assert.deepEqual(dropMcpStructuredContent([1, 2]), [1, 2]);
  });
});
