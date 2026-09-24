import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectMcpStreamableHttpSession } from "../src/mcp-streamable-http-transport";
import { MCP_PROTOCOL_VERSION_STREAMABLE } from "../src/mcp-protocol-versions";

/**
 * Helpers to build fake SSE ReadableStream bodies and fake Response objects
 * so we can mock `fetch` without a real HTTP server.
 */

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, headers?: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sseResponse(chunks: string[], headers?: Record<string, string>, status = 200): Response {
  return new Response(sseBody(chunks), {
    status,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", ...headers },
  });
}

function acceptedResponse(): Response {
  return new Response(null, { status: 202 });
}

/**
 * Captures GET request headers from mocked fetch calls.
 * Returns a list of headers objects for each GET request made.
 */
function capturedGetHeaders(mockFn: ReturnType<typeof vi.fn>): Record<string, string>[] {
  return (
    mockFn.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .filter(([_url, init]: [string, RequestInit]) => init?.method === "GET")
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(([_url, init]: [string, RequestInit]) => {
        const h = init?.headers;
        if (!h) return {};
        if (h instanceof Headers) {
          const out: Record<string, string> = {};
          h.forEach((v, k) => {
            out[k] = v;
          });
          return out;
        }
        if (Array.isArray(h)) {
          const out: Record<string, string> = {};
          for (const [k, v] of h) out[k] = v;
          return out;
        }
        // Plain object — lowercase keys for consistency
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          out[k.toLowerCase()] = v;
        }
        return out;
      })
  );
}

describe("standing GET SSE Last-Event-ID resumption", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends Last-Event-ID on GET reconnect after receiving SSE events with id: fields", async () => {
    let getCallCount = 0;
    // We need a deferred promise so we can resolve the tool call result on the second GET
    let resolveToolCall: ((v: unknown) => void) | undefined;
    const toolCallPromise = new Promise((r) => {
      resolveToolCall = r;
    });

    mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const method = init?.method ?? "GET";

      if (method === "POST") {
        const body = JSON.parse(init.body as string) as {
          method?: string;
          id?: number;
        };

        if (body.method === "initialize") {
          return jsonResponse(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
                capabilities: {},
                serverInfo: { name: "mock", version: "1" },
              },
            },
            { "MCP-Session-Id": "sess-resume-test" },
          );
        }
        if (body.method === "notifications/initialized") {
          return acceptedResponse();
        }
        if (body.method === "tools/list") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }],
            },
          });
        }
        if (body.method === "tools/call") {
          // Return 202 so the result must come via standing GET
          // Store the id so we can deliver it on the second GET
          resolveToolCall?.(body.id);
          return acceptedResponse();
        }
        return new Response(null, { status: 400 });
      }

      if (method === "GET") {
        getCallCount++;
        if (getCallCount === 1) {
          // First GET: send SSE events WITH id: fields, then end (simulating disconnect)
          return sseResponse([
            `id: evt-42\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "test/ping", params: {} })}\n\n`,
            `id: evt-99\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "test/ping2", params: {} })}\n\n`,
          ]);
        }
        if (getCallCount === 2) {
          // Second GET (reconnect): wait for tool call, then deliver result
          const toolId = await toolCallPromise;
          return sseResponse([
            `id: evt-100\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: toolId, result: { resumed: true } })}\n\n`,
          ]);
        }
        // Further GETs: just hang (return a stream that never closes)
        return sseResponse([]);
      }

      return new Response(null, { status: 405 });
    });

    const session = connectMcpStreamableHttpSession({
      url: "http://mock-server/mcp",
    });

    // Initialize
    await session.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await session.notify("notifications/initialized");

    // List tools (triggers standing GET via ensureStandingGet)
    await session.request("tools/list", {});

    // Wait for first GET to connect, receive events with ids, and disconnect
    await new Promise((r) => setTimeout(r, 200));

    // Invoke tool — POST returns 202, result comes on reconnected GET
    const result = await session.request("tools/call", {
      name: "t",
      arguments: {},
    });
    expect(result).toEqual({ resumed: true });

    // Verify GET reconnect headers
    const getHeaders = capturedGetHeaders(mockFetch);
    expect(getHeaders.length).toBeGreaterThanOrEqual(2);

    // First GET should NOT have Last-Event-ID
    expect(getHeaders[0]!["last-event-id"]).toBeUndefined();

    // Second GET (reconnect) SHOULD have Last-Event-ID set to the last id from the first stream
    expect(getHeaders[1]!["last-event-id"]).toBe("evt-99");

    await session.close();
  });

  it("does NOT send Last-Event-ID on GET reconnect when no id: fields were received", async () => {
    let getCallCount = 0;
    let resolveToolCall: ((v: unknown) => void) | undefined;
    const toolCallPromise = new Promise((r) => {
      resolveToolCall = r;
    });

    mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const method = init?.method ?? "GET";

      if (method === "POST") {
        const body = JSON.parse(init.body as string) as {
          method?: string;
          id?: number;
        };

        if (body.method === "initialize") {
          return jsonResponse(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
                capabilities: {},
                serverInfo: { name: "mock-noid", version: "1" },
              },
            },
            { "MCP-Session-Id": "sess-noid-test" },
          );
        }
        if (body.method === "notifications/initialized") {
          return acceptedResponse();
        }
        if (body.method === "tools/list") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }],
            },
          });
        }
        if (body.method === "tools/call") {
          resolveToolCall?.(body.id);
          return acceptedResponse();
        }
        return new Response(null, { status: 400 });
      }

      if (method === "GET") {
        getCallCount++;
        if (getCallCount === 1) {
          // First GET: send SSE events WITHOUT id: fields, then end (disconnect)
          return sseResponse([
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "test/noid", params: {} })}\n\n`,
          ]);
        }
        if (getCallCount === 2) {
          const toolId = await toolCallPromise;
          return sseResponse([
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: toolId, result: { noResume: true } })}\n\n`,
          ]);
        }
        return sseResponse([]);
      }

      return new Response(null, { status: 405 });
    });

    const session = connectMcpStreamableHttpSession({
      url: "http://mock-server/mcp",
    });

    await session.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await session.notify("notifications/initialized");
    await session.request("tools/list", {});

    // Wait for first GET to connect, receive events without ids, and disconnect
    await new Promise((r) => setTimeout(r, 200));

    const result = await session.request("tools/call", {
      name: "t",
      arguments: {},
    });
    expect(result).toEqual({ noResume: true });

    // Verify GET reconnect headers
    const getHeaders = capturedGetHeaders(mockFetch);
    expect(getHeaders.length).toBeGreaterThanOrEqual(2);

    // First GET: no Last-Event-ID
    expect(getHeaders[0]!["last-event-id"]).toBeUndefined();

    // Second GET: also no Last-Event-ID since server never sent id: fields
    expect(getHeaders[1]!["last-event-id"]).toBeUndefined();

    await session.close();
  });
});
