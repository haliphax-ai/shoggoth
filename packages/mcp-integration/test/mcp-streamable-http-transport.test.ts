import assert from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { mcpFetchToolsList, mcpInvokeTool } from "../src/mcp-jsonrpc-transport";
import {
  connectMcpStreamableHttpSession,
  iterateSseDataJson,
  openMcpStreamableHttpClient,
  type McpSseJsonEvent,
  type McpStreamableHttpServerMessage,
} from "../src/mcp-streamable-http-transport";
import { mcpInitializeSession } from "../src/mcp-jsonrpc-transport";

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
              protocolVersion: "2025-11-25",
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
                  inputSchema: { type: "object", properties: { text: { type: "string" } } },
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
              protocolVersion: "2025-11-25",
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
            result: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] },
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

    const session = await openMcpStreamableHttpClient({ url: baseUrl });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools[0]!.name, "ping");
      const r = await mcpInvokeTool(session, "ping", {});
      assert.deepEqual(r, { ok: true, via: "sse" });
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
          enc.encode("id: alpha\r\ndata: {\"x\":1}\r\n\r\nid: beta\ndata: {\"y\":2}\n\n"),
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
              protocolVersion: "2025-11-25",
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
            result: { tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }] },
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
              protocolVersion: "2025-11-25",
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
            result: { tools: [{ name: "g", inputSchema: { type: "object", properties: {} } }] },
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
              protocolVersion: "2025-11-25",
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
            result: { tools: [{ name: "u", inputSchema: { type: "object", properties: {} } }] },
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
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { via: "retry" } })}\n\n`,
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
              protocolVersion: "2025-11-25",
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
            result: { tools: [{ name: "c", inputSchema: { type: "object", properties: {} } }] },
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
              protocolVersion: "2025-11-25",
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
            result: { tools: [{ name: "x", inputSchema: { type: "object", properties: {} } }] },
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
              protocolVersion: "2025-11-25",
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
            result: { tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }] },
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

  it("cancelRequest sends notifications/cancelled with requestId", async () => {
    let lastNotification: unknown;
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as { method?: string; id?: number; params?: unknown };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-11-25",
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
      await mcpInitializeSession(session, { protocolVersion: "2025-11-25" });
      session.cancelRequest(42);
      await new Promise((r) => setTimeout(r, 30));
      const n = lastNotification as { method?: string; params?: { requestId?: number } };
      assert.equal(n.method, "notifications/cancelled");
      assert.equal(n.params?.requestId, 42);
    } finally {
      await session.close();
      server.close();
    }
  });
});
