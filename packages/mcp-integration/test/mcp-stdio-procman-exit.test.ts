/**
 * Procman-managed stdio MCP server death signaling:
 *  - the managed child exiting fires the session's onServerExit tap exactly once
 *  - pending and subsequent requests reject (stream ended) instead of hanging
 *  - a deliberate close() does NOT fire the exit tap (expected teardown)
 */
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { ProcessManager } from "@shoggoth/procman";
import {
  connectMcpStdioSession,
  mcpInitializeSession,
  type McpStdioConnectOptions,
} from "../src/mcp-jsonrpc-transport";

const exitAfter1sServerPath = fileURLToPath(
  new URL("fixtures/mock-mcp-server-exit-after.mjs", import.meta.url),
);
const mockServerPath = fileURLToPath(new URL("fixtures/mock-mcp-server.mjs", import.meta.url));

describe("connectMcpStdioSession via procman — server exit signaling", () => {
  it("fires onServerExit once when the managed child dies", async () => {
    const pm = new ProcessManager();
    try {
      const exitEvents: { exitCode: number | null; signal: string | null }[] = [];
      const opts: McpStdioConnectOptions = {
        command: process.execPath,
        args: [exitAfter1sServerPath, "50"],
        // No restart policy — a crash exit must not be resurrected for this test.
        processManager: pm,
        onServerExit: (info) => {
          exitEvents.push({ exitCode: info.exitCode, signal: info.signal ?? null });
        },
      };
      const session = await connectMcpStdioSession(opts);
      await mcpInitializeSession(session);

      // Wait for the child to exit (50 ms) plus margin.
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(
        exitEvents.length,
        1,
        `expected exactly one exit event, got ${JSON.stringify(exitEvents)}`,
      );
      // The mock exits itself with code 0 after the delay.
      assert.equal(exitEvents[0]!.exitCode, 0);

      // Requests against the dead session reject promptly (stream ended).
      await assert.rejects(
        session.request("tools/list"),
        /MCP (JSON-RPC stream ended|session is closed)/,
      );
    } finally {
      await pm.stopAll();
    }
  });

  it("does not fire onServerExit on a deliberate close", async () => {
    const pm = new ProcessManager();
    try {
      let exits = 0;
      const session = await connectMcpStdioSession({
        command: process.execPath,
        args: [mockServerPath],
        processManager: pm,
        onServerExit: () => {
          exits += 1;
        },
      });
      await mcpInitializeSession(session);
      await session.close();
      // Managed stop is a deliberate teardown, not a death signal.
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(exits, 0, "deliberate close must not fire the exit tap");
    } finally {
      await pm.stopAll();
    }
  });
});
