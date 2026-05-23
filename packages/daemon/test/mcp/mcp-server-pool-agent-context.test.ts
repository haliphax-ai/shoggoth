/**
 * Tests: verify that connectShoggothMcpServers threads AgentMcpContext
 * (uid, gid, workspacePath) through to the stdio connect options.
 *
 * These tests mock @shoggoth/mcp-integration so we can inspect the options
 * passed to openMcpStdioClient without spawning real processes.
 */
import assert from "node:assert";
import { describe, it, vi, beforeEach } from "vitest";
import type { McpJsonRpcSession, McpStdioConnectOptions } from "@shoggoth/mcp-integration";

// ---------------------------------------------------------------------------
// Capture every call to openMcpStdioClient so we can inspect the options.
// ---------------------------------------------------------------------------
const capturedStdioOpts: McpStdioConnectOptions[] = [];

const fakeSession: McpJsonRpcSession = {
  request: vi.fn().mockResolvedValue({ tools: [] }),
  notify: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@shoggoth/mcp-integration", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    openMcpStdioClient: vi.fn(async (opts: McpStdioConnectOptions) => {
      capturedStdioOpts.push(opts);
      return fakeSession;
    }),
    mcpFetchToolsList: vi.fn(async () => []),
    mcpToolsToSourceCatalog: vi.fn((sourceId: string) => ({
      sourceId,
      tools: [],
    })),
  };
});

vi.mock("../../src/process-manager-singleton", () => ({
  getProcessManager: vi.fn(() => undefined),
}));

import {
  connectShoggothMcpServers,
  type ConnectShoggothMcpPoolOptions,
} from "../../src/mcp/mcp-server-pool";

describe("connectShoggothMcpServers — agentContext forwarding", () => {
  beforeEach(() => {
    capturedStdioOpts.length = 0;
  });

  it("sets HOME, cwd, uid, and gid from agentContext for stdio servers", async () => {
    const { pool } = await connectShoggothMcpServers(
      [
        {
          id: "srv1",
          transport: "stdio",
          command: "/usr/bin/echo",
          args: ["hello"],
        },
      ],
      {
        agentContext: {
          uid: 2001,
          gid: 2001,
          workspacePath: "/home/agent-a/workspace",
        },
      } as ConnectShoggothMcpPoolOptions,
    );

    try {
      assert.equal(capturedStdioOpts.length, 1, "openMcpStdioClient should be called once");
      const opts = capturedStdioOpts[0]!;

      // uid/gid should be forwarded
      assert.equal(
        (opts as any).uid,
        2001,
        "uid from agentContext should be passed to stdio connect options",
      );
      assert.equal(
        (opts as any).gid,
        2001,
        "gid from agentContext should be passed to stdio connect options",
      );

      // cwd should default to workspacePath
      assert.equal(
        opts.cwd,
        "/home/agent-a/workspace",
        "cwd should default to agentContext.workspacePath",
      );

      // HOME should be set in env
      assert.equal(
        opts.env?.HOME,
        "/home/agent-a/workspace",
        "HOME env var should be set to agentContext.workspacePath",
      );
    } finally {
      await pool.close();
    }
  });

  it("server-level cwd overrides agentContext.workspacePath", async () => {
    const { pool } = await connectShoggothMcpServers(
      [
        {
          id: "srv-cwd",
          transport: "stdio",
          command: "/usr/bin/echo",
          cwd: "/custom/cwd",
        },
      ],
      {
        agentContext: {
          uid: 3001,
          gid: 3001,
          workspacePath: "/home/agent-b/workspace",
        },
      } as ConnectShoggothMcpPoolOptions,
    );

    try {
      assert.equal(capturedStdioOpts.length, 1);
      const opts = capturedStdioOpts[0]!;

      // Server-specified cwd takes precedence
      assert.equal(
        opts.cwd,
        "/custom/cwd",
        "server-level cwd should override agentContext.workspacePath",
      );

      // uid/gid still forwarded
      assert.equal((opts as any).uid, 3001);
      assert.equal((opts as any).gid, 3001);

      // HOME still set
      assert.equal(opts.env?.HOME, "/home/agent-b/workspace");
    } finally {
      await pool.close();
    }
  });

  it("preserves existing behavior when agentContext is absent", async () => {
    const { pool } = await connectShoggothMcpServers([
      {
        id: "srv-no-ctx",
        transport: "stdio",
        command: "/usr/bin/echo",
        env: { FOO: "bar" },
      },
    ]);

    try {
      assert.equal(capturedStdioOpts.length, 1);
      const opts = capturedStdioOpts[0]!;

      // No uid/gid should be set
      assert.equal(
        (opts as any).uid,
        undefined,
        "uid should not be set when agentContext is absent",
      );
      assert.equal(
        (opts as any).gid,
        undefined,
        "gid should not be set when agentContext is absent",
      );

      // env should pass through server-level env only
      assert.equal(opts.env?.FOO, "bar", "server-level env should be preserved");
      assert.equal(
        opts.env?.HOME,
        undefined,
        "HOME should not be injected when agentContext is absent",
      );
    } finally {
      await pool.close();
    }
  });

  it("merges agentContext HOME with server-level env vars", async () => {
    const { pool } = await connectShoggothMcpServers(
      [
        {
          id: "srv-merge",
          transport: "stdio",
          command: "/usr/bin/echo",
          env: { MY_VAR: "value" },
        },
      ],
      {
        agentContext: {
          uid: 4001,
          gid: 4001,
          workspacePath: "/home/agent-c/workspace",
        },
      } as ConnectShoggothMcpPoolOptions,
    );

    try {
      assert.equal(capturedStdioOpts.length, 1);
      const opts = capturedStdioOpts[0]!;

      // Both server-level env and agentContext HOME should be present
      assert.equal(opts.env?.MY_VAR, "value", "server-level env vars should be preserved");
      assert.equal(
        opts.env?.HOME,
        "/home/agent-c/workspace",
        "HOME should be merged from agentContext",
      );
    } finally {
      await pool.close();
    }
  });
});
