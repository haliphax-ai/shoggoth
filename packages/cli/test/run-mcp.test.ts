import { describe, it } from "node:test";
import assert from "node:assert";
import { parseMcpCancelCliArgs } from "../src/run-mcp";

describe("parseMcpCancelCliArgs", () => {
  it("parses three argv tokens into payload", () => {
    const out = parseMcpCancelCliArgs(["__global__", "my_mcp", "42"]);
    assert.deepStrictEqual(out, {
      ok: true,
      payload: { session_id: "__global__", source_id: "my_mcp", request_id: 42 },
    });
  });

  it("truncates float request ids", () => {
    const out = parseMcpCancelCliArgs(["s", "src", "3.9"]);
    assert.equal(out.ok && out.payload.request_id, 3);
  });

  it("rejects missing args", () => {
    const out = parseMcpCancelCliArgs(["a", "b"]);
    assert.equal(out.ok, false);
  });

  it("rejects non-numeric request id", () => {
    const out = parseMcpCancelCliArgs(["a", "b", "x"]);
    assert.equal(out.ok, false);
  });
});
