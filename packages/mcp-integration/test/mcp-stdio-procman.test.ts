import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { ProcessManager } from "@shoggoth/procman";
import {
  connectMcpStdioSession,
  mcpFetchToolsList,
  mcpInitializeSession,
  mcpInvokeTool,
  openMcpStdioClient,
} from "../src/mcp-jsonrpc-transport";

const mockServerPath = fileURLToPath(new URL("fixtures/mock-mcp-server.mjs", import.meta.url));

describe("connectMcpStdioSession via procman", () => {
  it("spawns via ProcessManager, lists tools, and calls echo", async () => {
    const pm = new ProcessManager();
    try {
      const session = await connectMcpStdioSession({
        command: process.execPath,
        args: [mockServerPath],
        processManager: pm,
      });
      try {
        await mcpInitializeSession(session);
        const tools = await mcpFetchToolsList(session);
        assert.equal(tools.length, 1);
        assert.equal(tools[0]!.name, "echo");
        const out = await mcpInvokeTool(session, "echo", { text: "procman" });
        const o = out as { content?: { type: string; text: string }[] };
        assert.equal(o.content?.[0]?.text, "procman");
      } finally {
        await session.close();
      }
    } finally {
      await pm.stopAll();
    }
  });

  it("close() stops the managed process in procman", async () => {
    const pm = new ProcessManager();
    try {
      const session = await connectMcpStdioSession({
        command: process.execPath,
        args: [mockServerPath],
        processManager: pm,
      });

      // Process should be registered in procman
      const before = pm.listByOwner({ kind: "mcp-server" });
      assert.equal(before.length, 1, "expected 1 mcp-server process registered");

      await mcpInitializeSession(session);
      await session.close();

      // After close, the process should be removed from procman
      const after = pm.listByOwner({ kind: "mcp-server" });
      assert.equal(after.length, 0, "expected 0 mcp-server processes after close");
    } finally {
      await pm.stopAll();
    }
  });
});

describe("connectMcpStdioSession without procman (backward compat)", () => {
  it("still works with direct spawn when no processManager provided", async () => {
    const session = await openMcpStdioClient({
      command: process.execPath,
      args: [mockServerPath],
    });
    try {
      const tools = await mcpFetchToolsList(session);
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.name, "echo");
    } finally {
      await session.close();
    }
  });
});

describe("openMcpStdioClient via procman", () => {
  it("passes processManager through to connectMcpStdioSession", async () => {
    const pm = new ProcessManager();
    try {
      const session = await openMcpStdioClient({
        command: process.execPath,
        args: [mockServerPath],
        processManager: pm,
      });
      try {
        // openMcpStdioClient already ran initialize, so we can call tools directly
        const tools = await mcpFetchToolsList(session);
        assert.equal(tools.length, 1);
        assert.equal(tools[0]!.name, "echo");

        // Verify it's managed by procman
        const managed = pm.listByOwner({ kind: "mcp-server" });
        assert.equal(managed.length, 1);
      } finally {
        await session.close();
      }
    } finally {
      await pm.stopAll();
    }
  });
});
