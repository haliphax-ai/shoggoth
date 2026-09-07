/**
 * Tests: verify that connectShoggothMcpServers threads AgentMcpContext
 * (uid, gid, workspacePath) through to the stdio connect options,
 * and that process.env is inherited as the base environment.
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

  it("inherits process.env and preserves server-level env when agentContext is absent", async () => {
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

      // process.env should be inherited
      assert.ok(
        opts.env?.PATH !== undefined,
        "process.env should be inherited when agentContext is absent",
      );

      // Server-level env should be present on top of process.env
      assert.equal(opts.env?.FOO, "bar", "server-level env should be preserved");
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

  it("inherits process.env variables like PATH", async () => {
    const { pool } = await connectShoggothMcpServers(
      [
        {
          id: "srv-env-inherit",
          transport: "stdio",
          command: "/usr/bin/echo",
          args: ["hello"],
        },
      ],
      {
        agentContext: {
          uid: 5001,
          gid: 5001,
          workspacePath: "/home/agent-d/workspace",
        },
      } as ConnectShoggothMcpPoolOptions,
    );

    try {
      assert.equal(capturedStdioOpts.length, 1);
      const opts = capturedStdioOpts[0]!;

      // process.env.PATH should be inherited
      assert.equal(
        opts.env?.PATH,
        process.env.PATH,
        "process.env.PATH should be inherited into the stdio env",
      );

      // HOME should still be overridden by agentContext
      assert.equal(
        opts.env?.HOME,
        "/home/agent-d/workspace",
        "agentContext HOME should override process.env HOME",
      );
    } finally {
      await pool.close();
    }
  });

  it("server config env vars override process.env values", async () => {
    const { pool } = await connectShoggothMcpServers(
      [
        {
          id: "srv-env-override",
          transport: "stdio",
          command: "/usr/bin/echo",
          env: { SSL_CERT_FILE: "/custom/cert.pem" },
        },
      ],
      {
        agentContext: {
          uid: 6001,
          gid: 6001,
          workspacePath: "/home/agent-e/workspace",
        },
      } as ConnectShoggothMcpPoolOptions,
    );

    try {
      assert.equal(capturedStdioOpts.length, 1);
      const opts = capturedStdioOpts[0]!;

      // Server config env should override any process.env value
      assert.equal(
        opts.env?.SSL_CERT_FILE,
        "/custom/cert.pem",
        "server config env vars should override process.env",
      );

      // process.env values not overridden should still be present
      assert.equal(
        opts.env?.PATH,
        process.env.PATH,
        "non-overridden process.env values should be inherited",
      );
    } finally {
      await pool.close();
    }
  });

  it("inherits process.env even when agentContext is absent and no server env", async () => {
    const { pool } = await connectShoggothMcpServers([
      {
        id: "srv-env-only-process",
        transport: "stdio",
        command: "/usr/bin/echo",
      },
    ]);

    try {
      assert.equal(capturedStdioOpts.length, 1);
      const opts = capturedStdioOpts[0]!;

      // process.env should be inherited as the base
      assert.equal(
        opts.env?.PATH,
        process.env.PATH,
        "process.env.PATH should be inherited without agentContext",
      );
    } finally {
      await pool.close();
    }
  });
});
