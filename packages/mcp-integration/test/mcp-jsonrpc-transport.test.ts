import assert from "node:assert";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  connectMcpTcpSession,
  mcpFetchToolsList,
  mcpInvokeTool,
  openMcpStdioClient,
  openMcpTcpClient,
} from "../src/mcp-jsonrpc-transport";
import { MCP_PROTOCOL_VERSION_STDIO } from "../src/mcp-protocol-versions";

const mockServerPath = fileURLToPath(new URL("fixtures/mock-mcp-server.mjs", import.meta.url));

describe("mcp-jsonrpc-transport (stdio)", () => {
  it("initializes, lists tools, and calls echo", async () => {
    const session = await openMcpStdioClient({
      command: process.execPath,
      args: [mockServerPath],
    });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.name, "echo");
      const out = await mcpInvokeTool(session, "echo", { text: "hi" });
      const o = out as { content?: { type: string; text: string }[] };
      assert.equal(o.content?.[0]?.text, "hi");
    } finally {
      await session.close();
    }
  });
});

describe("mcp-jsonrpc-transport (tcp)", () => {
  it("speaks line-delimited JSON-RPC over a socket", async () => {
    const malformedJson: string[] = [];
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl < 0) break;
          const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg: {
            method?: string;
            id?: number;
            params?: { arguments?: { text?: string } };
          };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch (err) {
            // Record malformed input instead of silently swallowing it; the
            // test asserts this stays empty so it fails if the client ever
            // sends unparseable JSON (finding #15).
            malformedJson.push(`${err instanceof Error ? err.message : String(err)}: ${line}`);
            continue;
          }
          const { method, id } = msg;
          if (method === "initialize") {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  protocolVersion: MCP_PROTOCOL_VERSION_STDIO,
                  capabilities: {},
                  serverInfo: { name: "tcp-mock", version: "1" },
                },
              })}\n`,
            );
          } else if (method === "notifications/initialized") {
            /* skip */
          } else if (method === "tools/list") {
            socket.write(
              `${JSON.stringify({
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
              })}\n`,
            );
          } else if (method === "tools/call") {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { ok: true },
              })}\n`,
            );
          }
        }
      });
    });

    const port: number = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") resolve(a.port);
        else reject(new Error("no port"));
      });
      server.on("error", reject);
    });

    const session = await openMcpTcpClient({ host: "127.0.0.1", port, connectTimeout: 500 });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools[0]!.name, "ping");
      const r = await mcpInvokeTool(session, "ping", {});
      assert.deepEqual(r, { ok: true });
      // The connect deadline must be cleared once the handshake completes:
      // an idle session survives past connectTimeout.
      await new Promise((resolve) => setTimeout(resolve, 700));
      const again = await mcpInvokeTool(session, "ping", {});
      assert.deepEqual(again, { ok: true });
      assert.equal(
        malformedJson.length,
        0,
        `mock server received malformed JSON: ${malformedJson.join(" | ")}`,
      );
    } finally {
      await session.close();
      server.close();
    }
  });

  it("rejects with ETIMEDOUT when connectTimeout elapses before the handshake completes", async () => {
    // 192.0.2.1 is TEST-NET-1: it blackholes SYNs, so without a deadline the
    // connect attempt would hang indefinitely.
    const start = Date.now();
    await assert.rejects(
      connectMcpTcpSession({ host: "192.0.2.1", port: 8123, connectTimeout: 400 }),
      (err: unknown) => {
        if (!(err instanceof Error)) return false;
        const code = (err as NodeJS.ErrnoException).code;
        // The connect deadline reports ETIMEDOUT; sandboxes that reject the
        // unroutable route immediately are also a prompt failure.
        return (
          code === "ETIMEDOUT" ||
          code === "EHOSTUNREACH" ||
          code === "ENETUNREACH" ||
          code === "ECONNREFUSED"
        );
      },
    );
    assert.ok(Date.now() - start < 10_000, "expected a prompt rejection, not an indefinite hang");
  });
});

describe("mcpFetchToolsList skipped tool entries", () => {
  it("reports entries with unexpected shape via onSkippedToolEntry", async () => {
    const skipped: unknown[] = [];
    const tools = await mcpFetchToolsList(
      {
        request: async () => ({
          tools: [{ name: "good" }, "not-an-object", { description: "nameless" }, 42],
        }),
        notify: () => {},
        close: async () => {},
      },
      { onSkippedToolEntry: (entry) => skipped.push(entry) },
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "good");
    assert.deepEqual(skipped, ["not-an-object", { description: "nameless" }, 42]);
  });

  it("does not require the callback (backward compatible)", async () => {
    const tools = await mcpFetchToolsList({
      request: async () => ({ tools: [{ name: "only" }] }),
      notify: () => {},
      close: async () => {},
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "only");
  });
});
