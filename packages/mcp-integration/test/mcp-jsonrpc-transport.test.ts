import assert from "node:assert";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  mcpFetchToolsList,
  mcpInvokeTool,
  openMcpStdioClient,
  openMcpTcpClient,
} from "../src/mcp-jsonrpc-transport";

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
          let msg: { method?: string; id?: number; params?: { arguments?: { text?: string } } };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            continue;
          }
          const { method, id } = msg;
          if (method === "initialize") {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  protocolVersion: "2024-11-05",
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

    const session = await openMcpTcpClient({ host: "127.0.0.1", port });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools[0]!.name, "ping");
      const r = await mcpInvokeTool(session, "ping", {});
      assert.deepEqual(r, { ok: true });
    } finally {
      await session.close();
      server.close();
    }
  });
});
