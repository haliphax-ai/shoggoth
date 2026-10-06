/**
 * Server-initiated JSON-RPC notifications (id-less messages carrying a `method`)
 * are delivered to the optional `onServerNotification` tap on the stdio/tcp
 * session while response matching is untouched and id-less non-notifications
 * (garbage or id-less responses) stay ignored.
 */
import assert from "node:assert";
import { PassThrough, type Readable } from "node:stream";
import { describe, it } from "vitest";
import {
  createMcpJsonRpcSession,
  mcpFetchToolsList,
  type McpServerNotification,
} from "../src/mcp-jsonrpc-transport";

/** Read one newline-delimited JSON message written by the session. */
function readLine(stream: Readable): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      stream.off("data", onData);
      resolve(buf.slice(0, nl));
    };
    stream.on("data", onData);
  });
}

function setup(tap?: (msg: McpServerNotification) => void, onProtocolError?: (e: unknown) => void) {
  const input = new PassThrough();
  const output = new PassThrough();
  const session = createMcpJsonRpcSession(input, output, {
    onServerNotification: tap,
    onProtocolError,
  });
  return { input, output, session };
}

describe("server notification tap (createMcpJsonRpcSession)", () => {
  it("delivers an id-less notification with method+params while responses still resolve", async () => {
    const received: McpServerNotification[] = [];
    const { input, output, session } = setup((m) => received.push(m));
    try {
      const reqPromise = readLine(output);
      const toolsPromise = mcpFetchToolsList(session);
      const req = JSON.parse(await reqPromise) as { id: number };

      // Out-of-band notification first, then the response to the pending request:
      // the tap must see the notification and the request must still resolve.
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: { source: "srv" },
        })}\n`,
      );
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { tools: [{ name: "alpha", inputSchema: { type: "object" } }] },
        })}\n`,
      );

      const tools = await toolsPromise;
      assert.deepEqual(
        tools.map((t) => t.name),
        ["alpha"],
      );
      assert.deepEqual(received, [
        { method: "notifications/tools/list_changed", params: { source: "srv" } },
      ]);
    } finally {
      await session.close();
    }
  });

  it("ignores id-less messages without a method and malformed lines", async () => {
    const received: McpServerNotification[] = [];
    const protocolErrors: unknown[] = [];
    const { input, output, session } = setup(
      (m) => received.push(m),
      (e) => protocolErrors.push(e),
    );
    try {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", result: { ok: true } })}\n`); // id-less response
      input.write(`${JSON.stringify({ jsonrpc: "2.0" })}\n`); // no id, no method
      input.write("this is not json\n"); // malformed → onProtocolError

      // The session stays fully functional afterwards.
      const reqPromise = readLine(output);
      const pong = session.request("ping");
      const req = JSON.parse(await reqPromise) as { id: number };
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pong: true } })}\n`);
      assert.deepEqual(await pong, { pong: true });

      assert.deepEqual(received, []);
      assert.equal(protocolErrors.length, 1);
    } finally {
      await session.close();
    }
  });

  it("does not deliver id-bearing messages to the notification tap", async () => {
    const received: McpServerNotification[] = [];
    const { input, session } = setup((m) => received.push(m));
    try {
      // A server→client request (has an id) is not a notification.
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 999, method: "server/ping" })}\n`);
      assert.deepEqual(received, []);
    } finally {
      await session.close();
    }
  });

  it("a throwing tap never breaks the read loop or response delivery", async () => {
    const { input, output, session } = setup(() => {
      throw new Error("tap boom");
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
      );

      const reqPromise = readLine(output);
      const pong = session.request("ping");
      const req = JSON.parse(await reqPromise) as { id: number };
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pong: true } })}\n`);
      assert.deepEqual(await pong, { pong: true });
    } finally {
      await session.close();
    }
  });
});
