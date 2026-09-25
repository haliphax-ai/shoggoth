import assert from "node:assert";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

type JsonRpcMessage = {
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
};

interface MockToolCallContext {
  req: IncomingMessage;
  res: ServerResponse;
  id?: number;
  params?: Record<string, unknown>;
  /** Standing GET SSE response when `get: "pending"` is active. */
  standingGet: ServerResponse | null;
}

interface MockMcpHttpServerOptions {
  /** serverInfo.name reported during initialize. */
  serverName?: string;
  /** MCP-Session-Id header returned on initialize. */
  sessionId?: string;
  /** Tools exposed by tools/list (defaults to a single echo tool). */
  toolDefs?: { name: string; inputSchema: unknown }[];
  /** Custom tools/call behavior; defaults to echoing the text argument. */
  onToolCall?(ctx: MockToolCallContext): void | Promise<void>;
  /** "pending" opens a standing GET SSE; "none" (default) replies 405. */
  get?: "none" | "pending";
  /** Invoked for each GET request when `get: "pending"`. */
  onGet?(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
  /** Invoked for every notification POST; default replies with a plain 202. */
  onNotification?(msg: JsonRpcMessage): void;
  /** Hook fired right after a tools/list response is sent. */
  afterToolsList?(getStandingGet: () => ServerResponse | null): void;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
} as const;

function startSse(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
}

function writeJsonRpcResult(res: ServerResponse, id: number | undefined, result: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

/**
 * Shared mock MCP streamable HTTP server: implements the initialize /
 * notifications / tools/list / tools/call plumbing once so each test only
 * supplies the behavior it actually exercises.
 */
function createMockMcpHttpServer(options: MockMcpHttpServerOptions = {}): Server {
  const {
    serverName = "mock",
    sessionId,
    toolDefs = [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
    onToolCall,
    get = "none",
    onGet,
    onNotification,
    afterToolsList,
  } = options;

  let standingGet: ServerResponse | null = null;

  return createServer(async (req, res: ServerResponse) => {
    if (req.method === "GET") {
      if (get === "none") {
        res.writeHead(405).end();
        return;
      }
      startSse(res);
      standingGet = res;
      req.on("close", () => {
        if (standingGet === res) standingGet = null;
      });
      await onGet?.(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const msg = (await readJsonBody(req)) as JsonRpcMessage | undefined;
    const { method, id } = msg ?? {};
    if (method === "initialize") {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (sessionId !== undefined) headers["MCP-Session-Id"] = sessionId;
      res.writeHead(200, headers);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
            capabilities: {},
            serverInfo: { name: serverName, version: "1" },
          },
        }),
      );
      return;
    }
    if (method?.startsWith("notifications/")) {
      onNotification?.(msg!);
      res.writeHead(202).end();
      return;
    }
    if (method === "tools/list") {
      writeJsonRpcResult(res, id, { tools: toolDefs });
      afterToolsList?.(() => standingGet);
      return;
    }
    if (method === "tools/call") {
      if (onToolCall) {
        await onToolCall({ req, res, id, params: msg!.params, standingGet });
        return;
      }
      const args = (msg!.params as { arguments?: { text?: string } } | undefined)?.arguments;
      writeJsonRpcResult(res, id, {
        content: [{ type: "text", text: String(args?.text ?? "") }],
      });
      return;
    }
    res.writeHead(400).end();
  });
}

async function startMockMcpHttpServer(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (a && typeof a === "object") {
        resolve(`http://127.0.0.1:${a.port}/mcp`);
      } else reject(new Error("addr"));
    });
    server.on("error", reject);
  });
}

describe("mcp-streamable-http-transport", () => {
  it("initializes with JSON responses, lists tools, calls tool", async () => {
    const server = createMockMcpHttpServer({
      serverName: "http-mock",
      sessionId: "sess-json-1",
      toolDefs: [
        {
          name: "echo",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "sse-mock",
      toolDefs: [{ name: "ping", inputSchema: { type: "object", properties: {} } }],
      onToolCall({ res, id }) {
        startSse(res);
        res.write(`event: message\n`);
        // Malformed event: must be skipped but reported via onParseError.
        res.write(`data: {broken json}\n\n`);
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true, via: "sse" } })}\n\n`,
        );
        res.end();
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "sse-retry",
      toolDefs: [{ name: "t", inputSchema: { type: "object", properties: {} } }],
      onToolCall({ req, res, id }) {
        toolCallPosts++;
        if (toolCallPosts === 1) {
          startSse(res);
          res.write("id: partial-1\n");
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "$/progress", params: {} })}\n\n`,
          );
          res.end();
          return;
        }
        assert.equal(req.headers["last-event-id"], "partial-1");
        startSse(res);
        res.write("id: final-2\n");
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { recovered: true } })}\n\n`,
        );
        res.end();
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "standing-get",
      sessionId: "sess-standing-get",
      toolDefs: [{ name: "g", inputSchema: { type: "object", properties: {} } }],
      get: "pending",
      onToolCall({ res, id, standingGet: sink }) {
        res.writeHead(202).end();
        if (sink && !sink.writableEnded) {
          sink.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { via: "standing-get" } })}\n\n`,
          );
        }
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "sse-net",
      toolDefs: [{ name: "u", inputSchema: { type: "object", properties: {} } }],
      onToolCall({ req, res, id }) {
        toolCallPosts++;
        if (toolCallPosts === 1) {
          startSse(res);
          res.write("id: net-drop\n");
          res.write(`data: ${JSON.stringify({ note: "not-json-rpc" })}\n\n`);
          // Defer so the kernel delivers the SSE block before RST (avoids flaky undici errors).
          setImmediate(() => res.socket?.destroy());
          return;
        }
        assert.equal(req.headers["last-event-id"], "net-drop");
        startSse(res);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { via: "retry" } })}\n\n`);
        res.end();
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "cancel-get",
      sessionId: "sess-cancel-get",
      toolDefs: [{ name: "c", inputSchema: { type: "object", properties: {} } }],
      get: "pending",
      onToolCall({ res, id, standingGet: sink }) {
        res.writeHead(202).end();
        if (sink && !sink.writableEnded && id !== undefined) {
          sink.write(
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id, reason: "mock cancel" },
            })}\n\n`,
          );
        }
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "cancel-sse-post",
      toolDefs: [{ name: "x", inputSchema: { type: "object", properties: {} } }],
      onToolCall({ res, id }) {
        startSse(res);
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id },
          })}\n\n`,
        );
        res.end();
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const inbound: McpStreamableHttpServerMessage[] = [];
    const server = createMockMcpHttpServer({
      serverName: "onmsg",
      sessionId: "sess-onmsg",
      toolDefs: [{ name: "t", inputSchema: { type: "object", properties: {} } }],
      get: "pending",
      afterToolsList(getStandingGet) {
        setImmediate(() => {
          const sink = getStandingGet();
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
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "get-resume",
      sessionId: "sess-get-resume",
      toolDefs: [{ name: "r", inputSchema: { type: "object", properties: {} } }],
      get: "pending",
      async onGet(req, res) {
        getCount++;
        getRequestHeaders.push({ ...req.headers });
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
          return;
        }
        // Further reconnects: just stay open
        req.on("close", () => {
          /* noop */
        });
      },
      onToolCall({ res, id }) {
        resolveToolCallId1?.(id!);
        // Return 202 so the result must come via standing GET
        res.writeHead(202).end();
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "get-noid",
      sessionId: "sess-get-noid",
      toolDefs: [{ name: "n", inputSchema: { type: "object", properties: {} } }],
      get: "pending",
      async onGet(req, res) {
        getCount++;
        getRequestHeaders.push({ ...req.headers });
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
          return;
        }
        req.on("close", () => {
          /* noop */
        });
      },
      onToolCall({ res, id }) {
        resolveToolCallId2?.(id!);
        res.writeHead(202).end();
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "get-multi",
      sessionId: "sess-get-multi",
      toolDefs: [{ name: "m", inputSchema: { type: "object", properties: {} } }],
      get: "pending",
      async onGet(req, res) {
        getCount++;
        getRequestHeaders.push({ ...req.headers });
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
          return;
        }
        req.on("close", () => {
          /* noop */
        });
      },
      onToolCall({ res, id }) {
        resolveToolCallId3?.(id!);
        res.writeHead(202).end();
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
    const server = createMockMcpHttpServer({
      serverName: "cancel-req",
      onNotification(msg) {
        lastNotification = msg;
      },
    });
    const baseUrl = await startMockMcpHttpServer(server);

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
