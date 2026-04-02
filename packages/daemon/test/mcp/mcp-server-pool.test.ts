import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_POLICY_CONFIG, type ShoggothMcpServerEntry } from "@shoggoth/shared";
import assert from "node:assert";
import Database from "better-sqlite3";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { runToolLoop } from "../../src/sessions/tool-loop";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { buildAggregatedMcpCatalog, createMcpRoutingToolExecutor, mcpToolsForToolLoop } from "../../src/mcp/tool-loop-mcp";
import { connectShoggothMcpServers, partitionMcpServersByEffectiveScope } from "../../src/mcp/mcp-server-pool";

const mockServerPath = fileURLToPath(
  new URL("../../../mcp-integration/test/fixtures/mock-mcp-server.mjs", import.meta.url),
);

describe("partitionMcpServersByEffectiveScope", () => {
  function stdio(id: string, poolScope?: "inherit" | "global" | "per_session"): ShoggothMcpServerEntry {
    const base = { id, transport: "stdio" as const, command: "true" };
    return poolScope === undefined ? base : { ...base, poolScope };
  }

  it("inherits top-level global by default", () => {
    const { globalServers, perSessionServers } = partitionMcpServersByEffectiveScope(
      [stdio("a"), stdio("b")],
      "global",
    );
    assert.deepEqual(
      globalServers.map((s) => s.id),
      ["a", "b"],
    );
    assert.equal(perSessionServers.length, 0);
  });

  it("splits per-server overrides against top-level global", () => {
    const { globalServers, perSessionServers } = partitionMcpServersByEffectiveScope(
      [stdio("g1"), stdio("p1", "per_session")],
      "global",
    );
    assert.deepEqual(globalServers.map((s) => s.id), ["g1"]);
    assert.deepEqual(perSessionServers.map((s) => s.id), ["p1"]);
  });

  it("per-server global overrides top-level per_session", () => {
    const { globalServers, perSessionServers } = partitionMcpServersByEffectiveScope(
      [stdio("g1", "global"), stdio("p1")],
      "per_session",
    );
    assert.deepEqual(globalServers.map((s) => s.id), ["g1"]);
    assert.deepEqual(perSessionServers.map((s) => s.id), ["p1"]);
  });
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw) as unknown;
}

describe("connectShoggothMcpServers + createMcpRoutingToolExecutor", () => {
  it("routes external tool calls to stdio MCP", async () => {
    const { pool, external } = await connectShoggothMcpServers([
      {
        id: "mocksrv",
        transport: "stdio",
        command: process.execPath,
        args: [mockServerPath],
      },
    ]);
    try {
      const aggregated = buildAggregatedMcpCatalog(pool.externalSources);
      assert.ok(aggregated.tools.some((t) => t.namespacedName === "mocksrv.echo"));

      const db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      migrate(db, defaultMigrationsDir());
      createSessionStore(db).create({ id: "s1", workspacePath: "/w" });
      const engine = createPolicyEngine(DEFAULT_POLICY_CONFIG);
      const principal: AuthenticatedPrincipal = {
        kind: "agent",
        sessionId: "s1",
        source: "agent",
      };
      const { policy, audit } = createToolLoopPolicyAndAudit({
        engine,
        principal,
        db,
        correlationId: "mcp-pool-test",
      });

      let step = 0;
      const model = {
        async complete() {
          if (step++ === 0) {
            return {
              content: null,
              toolCalls: [{ id: "c1", name: "mocksrv.echo", argsJson: '{"text":"from-mcp"}' }],
            };
          }
          return { content: "done", toolCalls: [] };
        },
      };

      const toolRuns = createToolRunStore(db);
      await runToolLoop({
        db,
        sessionId: "s1",
        runId: "run-ext-mcp",
        principalId: "s1",
        policy,
        audit,
        model,
        tools: mcpToolsForToolLoop(aggregated),
        executor: createMcpRoutingToolExecutor({
          aggregated,
          external,
          builtin: async () => ({ resultJson: "{}" }),
        }),
        toolRuns,
      });

      const row = db.prepare(`SELECT status FROM tool_runs WHERE id = ?`).get("run-ext-mcp") as
        | { status: string }
        | undefined;
      assert.equal(row?.status, "completed");
      db.close();
    } finally {
      await pool.close();
    }
  });

  it("routes external tool calls to streamable HTTP MCP", async () => {
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as {
        method?: string;
        id?: number;
        params?: { arguments?: { text?: string } };
      };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "pool-http-test",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "http-pool-mock", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "echo",
                  inputSchema: { type: "object", properties: { text: { type: "string" } } },
                },
              ],
            },
          }),
        );
        return;
      }
      if (method === "tools/call") {
        const text = msg.params?.arguments?.text ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: String(text) }] },
          }),
        );
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const { pool, external } = await connectShoggothMcpServers([
      {
        id: "httpsrv",
        transport: "http",
        url: baseUrl,
        headers: { "X-Pool-Test": "1" },
      },
    ]);
    try {
      const aggregated = buildAggregatedMcpCatalog(pool.externalSources);
      assert.ok(aggregated.tools.some((t) => t.namespacedName === "httpsrv.echo"));

      const db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      migrate(db, defaultMigrationsDir());
      createSessionStore(db).create({ id: "s-http", workspacePath: "/w" });
      const engine = createPolicyEngine(DEFAULT_POLICY_CONFIG);
      const principal: AuthenticatedPrincipal = {
        kind: "agent",
        sessionId: "s-http",
        source: "agent",
      };
      const { policy, audit } = createToolLoopPolicyAndAudit({
        engine,
        principal,
        db,
        correlationId: "mcp-pool-http-test",
      });

      let step = 0;
      const model = {
        async complete() {
          if (step++ === 0) {
            return {
              content: null,
              toolCalls: [{ id: "c1", name: "httpsrv.echo", argsJson: '{"text":"from-http"}' }],
            };
          }
          return { content: "done", toolCalls: [] };
        },
      };

      const toolRuns = createToolRunStore(db);
      await runToolLoop({
        db,
        sessionId: "s-http",
        runId: "run-http-mcp",
        principalId: "s-http",
        policy,
        audit,
        model,
        tools: mcpToolsForToolLoop(aggregated),
        executor: createMcpRoutingToolExecutor({
          aggregated,
          external,
          builtin: async () => ({ resultJson: "{}" }),
        }),
        toolRuns,
      });

      const row = db.prepare(`SELECT status FROM tool_runs WHERE id = ?`).get("run-http-mcp") as
        | { status: string }
        | undefined;
      assert.equal(row?.status, "completed");
      db.close();
    } finally {
      await pool.close();
      server.close();
    }
  });

  it("forwards streamable HTTP onServerMessage to onMcpServerMessage with sourceId", async () => {
    const received: { sourceId: string; method?: string }[] = [];
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { step: 1 },
          })}\n\n`,
        );
        setTimeout(() => res.end(), 40);
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as {
        method?: string;
        id?: number;
        params?: { arguments?: { text?: string } };
      };
      const { method, id } = msg;
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "sse-msg-test",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "http-sse-msg", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] },
          }),
        );
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const { pool } = await connectShoggothMcpServers(
      [
        {
          id: "sse-src",
          transport: "http",
          url: baseUrl,
        },
      ],
      {
        onMcpServerMessage: ({ sourceId, msg }) => {
          const m = msg as { method?: string };
          received.push({ sourceId, method: m.method });
        },
      },
    );
    try {
      await new Promise((r) => setTimeout(r, 250));
      assert.ok(received.some((x) => x.sourceId === "sse-src" && x.method === "notifications/progress"));
    } finally {
      await pool.close();
      server.close();
    }
  });

  it("cancelMcpRequest sends notifications/cancelled for HTTP transport", async () => {
    const cancelledParams: unknown[] = [];
    const server = createServer(async (req, res: ServerResponse) => {
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await readJsonBody(req)) as {
        method?: string;
        id?: number;
        params?: Record<string, unknown>;
      };
      const { method, id } = msg;
      if (method === "notifications/cancelled") {
        cancelledParams.push(msg.params);
        res.writeHead(202).end();
        return;
      }
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "MCP-Session-Id": "cancel-test",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "http-cancel", version: "1" },
            },
          }),
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] },
          }),
        );
        return;
      }
      res.writeHead(400).end();
    });

    const baseUrl: string = await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (a && typeof a === "object") {
          resolve(`http://127.0.0.1:${a.port}/mcp`);
        } else reject(new Error("addr"));
      });
      server.on("error", reject);
    });

    const { pool } = await connectShoggothMcpServers([
      {
        id: "http-cancel-src",
        transport: "http",
        url: baseUrl,
      },
    ]);
    try {
      assert.equal(pool.cancelMcpRequest?.("missing", 1), false);
      assert.equal(pool.cancelMcpRequest?.("http-cancel-src", 99), true);
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(
        cancelledParams.some((p) => {
          const o = p as { requestId?: number };
          return o?.requestId === 99;
        }),
      );
    } finally {
      await pool.close();
      server.close();
    }
  });
});
