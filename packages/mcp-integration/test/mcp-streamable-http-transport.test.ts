import assert from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "vitest";
import { mcpFetchToolsList, mcpInvokeTool } from "../src/mcp-jsonrpc-transport";
import {
  connectMcpStreamableHttpSession,
  iterateSseDataJson,
  openMcpStreamableHttpClient,
  type McpSseJsonEvent,
  type McpSseParseError,
  type McpStreamableHttpServerMessage,
} from "../src/mcp-streamable-http-transport";
import { mcpInitializeSession } from "../src/mcp-jsonrpc-transport";
import { MCP_PROTOCOL_VERSION_STREAMABLE } from "../src/mcp-protocol-versions";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw) as unknown;
}

describe("mcp-streamable-http-transport", () => {
  it("initializes with JSON responses, lists tools, calls tool", async () => {
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as {
        method?: string;
        id?: number;
        params?: { arguments?: { text?: string } };
      };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "sess-json-1",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "http-mock", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "echo",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                  },
                },
              ],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        const text = msg.params?.arguments?.text ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: String(text) }] },
          }),
        );
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({
      url: baseUrl,
      headers: { "X-Test": "1" },
    });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.name, "echo");
      const out = await mcpInvokeTool(session, "echo", { text: "http" });
      const o = out as { content?: { type: string; text: string }[] };
      assert.equal(o.content?.[0]?.text, "http");
    } finally {
      await session.close();
      server.close();
    }
  });

  it("accepts JSON-RPC result over SSE", async () => {
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "sse-mock", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "ping",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.write(`event: message\n`);
        // Malformed event: must be skipped but reported via onParseError.
        res.write(`data: {broken json}\n\n`);
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true, via: "sse" } })}\n\n`,
        );
        res.end();
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const parseErrors: McpSseParseError[] = [];
    const session = await openMcpStreamableHttpClient({
      url: baseUrl,
      onParseError: (e) => parseErrors.push(e),
    });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools[0]!.name, "ping");
      const r = await mcpInvokeTool(session, "ping", {});
      assert.deepEqual(r, { ok: true, via: "sse" });
      assert.equal(parseErrors.length, 1);
      assert.equal(parseErrors[0]!.data, "{broken json}");
      assert.ok(parseErrors[0]!.error instanceof Error);
    } finally {
      await session.close();
      server.close();
    }
  });

  it("iterateSseDataJson parses id and CRLF event boundaries", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode('id: alpha\r\ndata: {"x":1}\r\n\r\nid: beta\ndata: {"y":2}\n\n'),
        );
        controller.close();
      },
    });
    const out: McpSseJsonEvent[] = [];
    for await (const ev of iterateSseDataJson(stream)) {
      out.push(ev);
    }
    assert.equal(out.length, 2);
    assert.equal(out[0]!.eventId, "alpha");
    assert.deepEqual(out[0]!.json, { x: 1 });
    assert.equal(out[1]!.eventId, "beta");
    assert.deepEqual(out[1]!.json, { y: 2 });
  });

  it("iterateSseDataJson reports malformed JSON events via onParseError", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('id: bad\ndata: {oops}\n\nid: good\ndata: {"ok":true}\n\n'));
        controller.close();
      },
    });
    const errors: McpSseParseError[] = [];
    const out: McpSseJsonEvent[] = [];
    for await (const ev of iterateSseDataJson(stream, {
      onParseError: (e) => errors.push(e),
    })) {
      out.push(ev);
    }
    // Malformed event skipped; valid event still yielded.
    assert.equal(out.length, 1);
    assert.equal(out[0]!.eventId, "good");
    assert.deepEqual(out[0]!.json, { ok: true });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.eventId, "bad");
    assert.equal(errors[0]!.data, "{oops}");
    assert.ok(errors[0]!.error instanceof Error);
  });

  it("automatic SSE retry sends Last-Event-ID after partial stream", async () => {
    let toolCallPosts = 0;
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "sse-retry", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        toolCallPosts++;
        if (toolCallPosts === 1) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          res.write("id: partial-1\n");
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "$/progress", params: {} })}\n\n`,
          );
          res.end();
          return;
        }
        assert.equal(req.headers["last-event-id"], "partial-1");
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.write("id: final-2\n");
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { recovered: true } })}\n\n`,
        );
        res.end();
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      const r = await mcpInvokeTool(session, "t", {});
      assert.deepEqual(r, { recovered: true });
      assert.equal(toolCallPosts, 2);
      assert.equal(session.getLastSseEventId(), "final-2");
    } finally {
      await session.close();
      server.close();
    }
  });

  it("JSON-RPC result over standing GET when POST returns 202", async () => {
    let getRes: ServerResponse | null = null;
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        getRes = res;
        req.on("close", () => {
          getRes = null;
        });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "sess-standing-get",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "standing-get", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "g", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        res.writeHead(202).end();
        const sink = getRes;
        if (sink && !sink.writableEnded) {
          sink.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { via: "standing-get" } })}\n\n`,
          );
        }
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools[0]!.name, "g");
      const r = await mcpInvokeTool(session, "g", {});
      assert.deepEqual(r, { via: "standing-get" });
    } finally {
      await session.close();
      server.close();
    }
  });

  it("automatic SSE retry after read error when id was present", async () => {
    let toolCallPosts = 0;
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "sse-net", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "u", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        toolCallPosts++;
        if (toolCallPosts === 1) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          res.write("id: net-drop\n");
          res.write(`data: ${JSON.stringify({ note: "not-json-rpc" })}\n\n`);
          // Defer so the kernel delivers the SSE block before RST (avoids flaky undici errors).
          setImmediate(() => res.socket?.destroy());
          return;
        }
        assert.equal(req.headers["last-event-id"], "net-drop");
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { via: "retry" } })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      const r = await mcpInvokeTool(session, "u", {});
      assert.deepEqual(r, { via: "retry" });
      assert.equal(toolCallPosts, 2);
    } finally {
      await session.close();
      server.close();
    }
  });

  it("rejects pending request when server sends notifications/cancelled over standing GET SSE (202 flow)", async () => {
    let getRes: ServerResponse | null = null;
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        getRes = res;
        req.on("close", () => {
          getRes = null;
        });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "sess-cancel-get",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "cancel-get", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "c", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        res.writeHead(202).end();
        const sink = getRes;
        const rid = id;
        if (sink && !sink.writableEnded && rid !== undefined) {
          sink.write(
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: rid, reason: "mock cancel" },
            })}\n\n`,
          );
        }
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      await assert.rejects(mcpInvokeTool(session, "c", {}), (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /MCP request cancelled/);
        return true;
      });
    } finally {
      await session.close();
      server.close();
    }
  });

  it("rejects pending request when server sends notifications/cancelled on POST response SSE", async () => {
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "cancel-sse-post", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "x", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id },
          })}\n\n`,
        );
        res.end();
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      await assert.rejects(mcpInvokeTool(session, "x", {}), (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.equal(e.message, "MCP request cancelled");
        return true;
      });
    } finally {
      await session.close();
      server.close();
    }
  });

  it("onServerMessage receives JSON-RPC notification pushed on standing GET SSE", async () => {
    let getRes: ServerResponse | null = null;
    const inbound: McpStreamableHttpServerMessage[] = [];
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        getRes = res;
        req.on("close", () => {
          getRes = null;
        });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "sess-onmsg",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "onmsg", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        setImmediate(() => {
          const sink = getRes;
          if (sink && !sink.writableEnded) {
            sink.write(
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                method: "test/customNotification",
                params: { hello: "from-get" },
              })}\n\n`,
            );
          }
        });
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({
      url: baseUrl,
      onServerMessage: (m) => {
        inbound.push(m);
      },
    });
    try {
      await mcpFetchToolsList(session);
      await new Promise((r) => setTimeout(r, 80));
      const hit = inbound.find((m) => m.method === "test/customNotification");
      assert.ok(hit, "expected notification on inbound list");
      assert.deepEqual(hit.params, { hello: "from-get" });
    } finally {
      await session.close();
      server.close();
    }
  });

  it("standing GET reconnect sends Last-Event-ID after disconnect when server sent id: fields", async () => {
    const getRequestHeaders: Record<string, string | string[] | undefined>[] = [];
    let getCount = 0;
    let resolveToolCallId1: ((id: number) => void) | undefined;
    const toolCallIdPromise1 = new Promise<number>((r) => {
      resolveToolCallId1 = r;
    });
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "GET") {
        getCount++;
        getRequestHeaders.push({ ...req.headers });
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        if (getCount === 1) {
          // First GET: send an event with id, then close (simulate disconnect)
          res.write(
            `id: evt-100\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "test/ping", params: {} })}\n\n`,
          );
          res.write(
            `id: evt-200\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "test/ping2", params: {} })}\n\n`,
          );
          // Close the stream to simulate a disconnect
          res.end();
          return;
        }
        if (getCount === 2) {
          // Second GET (reconnect): should have Last-Event-ID: evt-200
          // Wait for the tool call, then deliver the result
          const toolCallId = await toolCallIdPromise1;
          res.write(
            `id: evt-300\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: toolCallId, result: { reconnected: true } })}\n\n`,
          );
          // Keep open briefly then end
          req.on("close", () => {
            /* noop */
          });
          return;
        }
        // Further reconnects: just stay open
        req.on("close", () => {
          /* noop */
        });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "sess-get-resume",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "get-resume", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "r", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        resolveToolCallId1?.(id!);
        // Return 202 so the result must come via standing GET
        res.writeHead(202).end();
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools[0]!.name, "r");
      // Wait for the first GET to connect, receive events, and disconnect
      await new Promise((r) => setTimeout(r, 150));
      // Now invoke a tool — POST returns 202, result comes on the reconnected GET
      const r = await mcpInvokeTool(session, "r", {});
      assert.deepEqual(r, { reconnected: true });
      // The second GET request should have included Last-Event-ID: evt-200
      assert.ok(getCount >= 2, `expected at least 2 GET requests, got `);
      const secondGetHeaders = getRequestHeaders[1]!;
      assert.equal(
        secondGetHeaders["last-event-id"],
        "evt-200",
        "second GET should carry Last-Event-ID from the last event of the first stream",
      );
    } finally {
      await session.close();
      server.close();
    }
  });

  it("standing GET reconnect does NOT send Last-Event-ID when server never sent id: fields", async () => {
    const getRequestHeaders: Record<string, string | string[] | undefined>[] = [];
    let getCount = 0;
    let resolveToolCallId2: ((id: number) => void) | undefined;
    const toolCallIdPromise2 = new Promise<number>((r) => {
      resolveToolCallId2 = r;
    });
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "GET") {
        getCount++;
        getRequestHeaders.push({ ...req.headers });
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        if (getCount === 1) {
          // First GET: send events WITHOUT id: fields, then close
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "test/noid", params: {} })}\n\n`,
          );
          res.end();
          return;
        }
        if (getCount === 2) {
          // Second GET (reconnect): should NOT have Last-Event-ID
          const toolCallId = await toolCallIdPromise2;
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: toolCallId, result: { noId: true } })}\n\n`,
          );
          req.on("close", () => {
            /* noop */
          });
          return;
        }
        req.on("close", () => {
          /* noop */
        });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "sess-get-noid",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "get-noid", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "n", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        resolveToolCallId2?.(id!);
        res.writeHead(202).end();
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools[0]!.name, "n");
      // Wait for first GET to connect, receive events without ids, and disconnect
      await new Promise((r) => setTimeout(r, 150));
      const r = await mcpInvokeTool(session, "n", {});
      assert.deepEqual(r, { noId: true });
      assert.ok(getCount >= 2, `expected at least 2 GET requests, got `);
      // The first GET should NOT have Last-Event-ID (fresh connection)
      assert.equal(
        getRequestHeaders[0]!["last-event-id"],
        undefined,
        "first GET should not have Last-Event-ID",
      );
      // The second GET should also NOT have Last-Event-ID since no id: fields were sent
      assert.equal(
        getRequestHeaders[1]!["last-event-id"],
        undefined,
        "second GET should not have Last-Event-ID when server never sent id: fields",
      );
    } finally {
      await session.close();
      server.close();
    }
  });

  it("standing GET reconnect updates Last-Event-ID across multiple disconnects", async () => {
    const getRequestHeaders: Record<string, string | string[] | undefined>[] = [];
    let getCount = 0;
    let resolveToolCallId3: ((id: number) => void) | undefined;
    const toolCallIdPromise3 = new Promise<number>((r) => {
      resolveToolCallId3 = r;
    });
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "GET") {
        getCount++;
        getRequestHeaders.push({ ...req.headers });
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        if (getCount === 1) {
          // First GET: send event with id, then disconnect
          res.write(
            `id: first-batch\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "test/a", params: {} })}\n\n`,
          );
          res.end();
          return;
        }
        if (getCount === 2) {
          // Second GET: send event with a new id, then disconnect again
          res.write(
            `id: second-batch\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "test/b", params: {} })}\n\n`,
          );
          res.end();
          return;
        }
        if (getCount === 3) {
          // Third GET: wait for tool call, then deliver the result
          const toolCallId = await toolCallIdPromise3;
          res.write(
            `id: third-batch\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: toolCallId, result: { multi: true } })}\n\n`,
          );
          req.on("close", () => {
            /* noop */
          });
          return;
        }
        req.on("close", () => {
          /* noop */
        });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "sess-get-multi",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "get-multi", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "m", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        resolveToolCallId3?.(id!);
        res.writeHead(202).end();
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      await mcpFetchToolsList(session);
      // Wait for GET #1 to connect, send events, disconnect, then GET #2 to do the same
      await new Promise((r) => setTimeout(r, 400));
      const r = await mcpInvokeTool(session, "m", {});
      assert.deepEqual(r, { multi: true });
      assert.ok(getCount >= 3, `expected at least 3 GET requests, got `);
      // First GET: no Last-Event-ID
      assert.equal(
        getRequestHeaders[0]!["last-event-id"],
        undefined,
        "first GET: no Last-Event-ID",
      );
      // Second GET: should carry "first-batch"
      assert.equal(
        getRequestHeaders[1]!["last-event-id"],
        "first-batch",
        "second GET: Last-Event-ID should be first-batch",
      );
      // Third GET: should carry "second-batch"
      assert.equal(
        getRequestHeaders[2]!["last-event-id"],
        "second-batch",
        "third GET: Last-Event-ID should be second-batch",
      );
    } finally {
      await session.close();
      server.close();
    }
  });

  it("cancelRequest sends notifications/cancelled with requestId", async () => {
    let lastNotification: unknown;
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as {
        method?: string;
        id?: number;
        params?: unknown;
      };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
              capabilities: {},
              serverInfo: { name: "cancel-req", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized" || method === "notifications/cancelled") {
        lastNotification = msg;
        res.writeHead(202).end();
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const session = connectMcpStreamableHttpSession({ url: baseUrl });
    try {
      await mcpInitializeSession(session, { protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE });
      session.cancelRequest(42);
      await new Promise((r) => setTimeout(r, 30));
      const n = lastNotification as {
        method?: string;
        params?: { requestId?: number };
      };
      assert.equal(n.method, "notifications/cancelled");
      assert.equal(n.params?.requestId, 42);
    } finally {
      await session.close();
      server.close();
    }
  });
});
