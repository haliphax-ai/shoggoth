/**
 * `notify()` returns `Promise<void>` on both session types so callers can await it
 * directly. `McpStreamableHttpSession` extends `McpJsonRpcSession`, so the signatures
 * must match exactly. These tests pin the contract at the type level and the runtime
 * level.
 */
import assert from "node:assert";
import { PassThrough } from "node:stream";
import { describe, expectTypeOf, it } from "vitest";
import { createMcpJsonRpcSession, type McpJsonRpcSession } from "../src/mcp-jsonrpc-transport";
import type { McpStreamableHttpSession } from "../src/mcp-streamable-http-transport";

describe("notify() return type alignment", () => {
  it("declares notify as (method, params?) => Promise<void> on both session types", () => {
    expectTypeOf<McpJsonRpcSession["notify"]>().toEqualTypeOf<
      (method: string, params?: unknown) => Promise<void>
    >();
    // Streamable HTTP intersects the JSON-RPC session — the signatures must match exactly.
    expectTypeOf<McpStreamableHttpSession["notify"]>().toEqualTypeOf<
      (method: string, params?: unknown) => Promise<void>
    >();
  });

  it("createMcpJsonRpcSession().notify() returns an awaitable Promise", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const session = createMcpJsonRpcSession(input, output);
    try {
      const result = session.notify("notifications/initialized", {});
      assert.ok(result instanceof Promise, `notify() must return a Promise, got ${typeof result}`);
      await result;
    } finally {
      await session.close();
    }
  });
});
