/* global process */
/**
 * MCP-style JSON-RPC server that exits itself after a delay (ms, argv[2]).
 * Used by tests that exercise server-death handling.
 *
 * When argv[3] is a marker file path: the FIRST instance (marker absent)
 * creates the marker and exits after the delay; any later instance (marker
 * present, e.g. a respawned one) stays alive. This makes "the server died
 * once, the replacement is stable" deterministic in tests.
 */
import * as readline from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

const delayMs = Number(process.argv[2] ?? "1000");
const markerPath = process.argv[3];
const stayAlive = markerPath !== undefined && existsSync(markerPath);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

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
          serverInfo: { name: "mock-mcp-exit", version: "0.0.1" },
        },
      })}\n`,
    );
    return;
  }
  if (method === "notifications/initialized") {
    if (!stayAlive) {
      if (markerPath !== undefined && !existsSync(markerPath)) {
        writeFileSync(markerPath, String(process.pid));
      }
      setTimeout(() => process.exit(0), delayMs);
    }
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
