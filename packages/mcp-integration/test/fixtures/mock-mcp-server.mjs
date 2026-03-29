/**
 * Minimal MCP-style JSON-RPC server on stdio for tests (initialize, tools/list, tools/call).
 *
 * **Not a test file** — spawned as a child process by `*.test.ts` suites. Do not pass this path to
 * `node --test` (readline keeps stdin open and the runner reports a pending event-loop / promise).
 */
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { method, id, params } = msg;
  if (method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "mock-mcp", version: "0.0.1" },
        },
      })}\n`,
    );
    return;
  }
  if (method === "notifications/initialized") {
    return;
  }
  if (method === "tools/list") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo text",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      })}\n`,
    );
    return;
  }
  if (method === "tools/call") {
    const text = params?.arguments?.text ?? "";
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(text) }] },
      })}\n`,
    );
  }
});
