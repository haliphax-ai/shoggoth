import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { MCP_PROTOCOL_VERSION_STREAMABLE } from "@shoggoth/mcp-integration";
import { DEFAULT_POLICY_CONFIG, type ShoggothMcpServerEntry } from "@shoggoth/shared";
import assert from "node:assert";
import Database from "better-sqlite3";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, it, vi, beforeEach, afterEach } from "vitest";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { runToolLoop } from "../../src/sessions/tool-loop";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import {
  buildAggregatedMcpCatalog,
  createMcpRoutingToolExecutor,
  isLapsedMcpSessionResult,
  mcpToolsForToolLoop,
} from "../../src/mcp/tool-loop-mcp";
import {
  connectShoggothMcpServers,
  partitionMcpServersByEffectiveScope,
} from "../../src/mcp/mcp-server-pool";

const mockServerPath = fileURLToPath(
  new URL("../../../mcp-integration/test/fixtures/mock-mcp-server.mjs", import.meta.url),
);

describe("partitionMcpServersByEffectiveScope", () => {
  function stdio(
    id: string,
    poolScope?: "inherit" | "global" | "per_session",
  ): ShoggothMcpServerEntry {
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
    assert.deepEqual(
      globalServers.map((s) => s.id),
      ["g1"],
    );
    assert.deepEqual(
      perSessionServers.map((s) => s.id),
      ["p1"],
    );
  });

  it("per-server global overrides top-level per_session", () => {
    const { globalServers, perSessionServers } = partitionMcpServersByEffectiveScope(
      [stdio("g1", "global"), stdio("p1")],
      "per_session",
    );
    assert.deepEqual(
      globalServers.map((s) => s.id),
      ["g1"],
    );
    assert.deepEqual(
      perSessionServers.map((s) => s.id),
      ["p1"],
    );
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
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
      assert.ok(aggregated.tools.some((t) => t.namespacedName === "mocksrv-echo"));

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
              toolCalls: [
                {
                  id: "c1",
                  name: "mocksrv-echo",
                  argsJson: '{"text":"from-mcp"}',
                },
              ],
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
      await pool.close().catch(() => {});
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
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
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
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                  },
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
      assert.ok(aggregated.tools.some((t) => t.namespacedName === "httpsrv-echo"));

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
              toolCalls: [
                {
                  id: "c1",
                  name: "httpsrv-echo",
                  argsJson: '{"text":"from-http"}',
                },
              ],
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
      await pool.close().catch(() => {});
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
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
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
            result: {
              tools: [
                {
                  name: "echo",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
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
      await vi.advanceTimersByTimeAsync(250);
      assert.ok(
        received.some((x) => x.sourceId === "sse-src" && x.method === "notifications/progress"),
      );
    } finally {
      await pool.close().catch(() => {});
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
              protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
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
            result: {
              tools: [
                {
                  name: "echo",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
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
      await vi.advanceTimersByTimeAsync(150);
      assert.ok(
        cancelledParams.some((p) => {
          const o = p as { requestId?: number };
          return o?.requestId === 99;
        }),
      );
    } finally {
      await pool.close().catch(() => {});
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Mid-turn MCP session lapse — end-to-end against a REAL pooled stdio session
// that was closed under the turn-captured `external` (the incident signature:
// 30-minute idle eviction vs. a turn that resolved its MCP context at start).
// ---------------------------------------------------------------------------
describe("MCP session lapse mid-turn — real pool close (stdio)", () => {
  const serverEntry: ShoggothMcpServerEntry = {
    id: "mocksrv",
    transport: "stdio",
    command: process.execPath,
    args: [mockServerPath],
  };

  it("reconnects and retries exactly once after the pooled session was closed", async () => {
    const first = await connectShoggothMcpServers([serverEntry]);
    let second: Awaited<ReturnType<typeof connectShoggothMcpServers>> | undefined;
    try {
      // Simulate idle eviction: close the pool under the turn-captured external.
      await first.pool.close();

      // Pin the real closed-session signature produced by transport + pool.
      const probe = await first.external({
        sourceId: "mocksrv",
        originalName: "echo",
        argsJson: '{"text":"probe"}',
        toolCallId: "probe",
      });
      const probeBody = JSON.parse(probe.resultJson) as { error?: string; message?: string };
      assert.equal(probeBody.error, "mcp_tools_call_failed");
      assert.match(probeBody.message ?? "", /MCP session is closed/);
      assert.equal(isLapsedMcpSessionResult(probe.resultJson), true);

      let reconnects = 0;
      let retryCalls = 0;
      const ex = createMcpRoutingToolExecutor({
        aggregated: buildAggregatedMcpCatalog(first.pool.externalSources),
        external: first.external,
        reconnectExternal: async () => {
          reconnects++;
          second = await connectShoggothMcpServers([serverEntry]);
          const inner = second.external;
          return (input) => {
            retryCalls++;
            return inner(input);
          };
        },
      });

      const out = await ex.execute({
        name: "mocksrv-echo",
        argsJson: '{"text":"recovered"}',
        toolCallId: "c1",
      });

      assert.equal(reconnects, 1, "exactly one reconnect");
      assert.equal(retryCalls, 1, "exactly one retry against the reconnected pool");
      assert.match(out.resultJson, /recovered/, "retry succeeded against the fresh pool");
    } finally {
      await second?.pool.close().catch(() => {});
    }
  });

  it("surfaces the closed-session error after one retry when the fresh pool is also closed", async () => {
    const first = await connectShoggothMcpServers([serverEntry]);
    let second: Awaited<ReturnType<typeof connectShoggothMcpServers>> | undefined;
    try {
      await first.pool.close();

      let reconnects = 0;
      let retryCalls = 0;
      const ex = createMcpRoutingToolExecutor({
        aggregated: buildAggregatedMcpCatalog(first.pool.externalSources),
        external: first.external,
        reconnectExternal: async () => {
          reconnects++;
          second = await connectShoggothMcpServers([serverEntry]);
          const inner = second.external;
          // The freshly connected pool lapses immediately too.
          await second.pool.close();
          return (input) => {
            retryCalls++;
            return inner(input);
          };
        },
      });

      const out = await ex.execute({
        name: "mocksrv-echo",
        argsJson: '{"text":"recovered"}',
        toolCallId: "c1",
      });

      assert.equal(reconnects, 1, "reconnect attempted at most once");
      assert.equal(retryCalls, 1, "single retry, then the failure surfaces as-is");
      const body = JSON.parse(out.resultJson) as { error?: string; message?: string };
      assert.equal(body.error, "mcp_tools_call_failed");
      assert.match(body.message ?? "", /MCP session is closed/);
    } finally {
      await second?.pool.close().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Parallel startup: configured servers connect concurrently, outcomes are
// gathered asynchronously, config order is preserved, and failures are
// isolated per server.
// ---------------------------------------------------------------------------

type MockMcpHttpHandle = {
  readonly url: string;
  readonly close: () => void;
};

/**
 * Minimal streamable-HTTP MCP server. `events` is shared across instances and
 * records `${label}:initialize` / `${label}:tools` / `${label}:delete` in the
 * order the server experiences them.
 */
async function startMockMcpHttp(opts: {
  readonly label: string;
  readonly events: string[];
  /** Awaited before the initialize response is sent (barrier hook). */
  readonly onInitialize?: () => Promise<void>;
  /** Reply to tools/list with a JSON-RPC error instead of the tool list. */
  readonly failToolsList?: boolean;
  /** Called when this server serves tools/list (ordering gate hook). */
  readonly onToolsList?: () => void;
}): Promise<MockMcpHttpHandle> {
  const server = createServer(async (req, res: ServerResponse) => {
    if (req.method === "DELETE") {
      opts.events.push(`${opts.label}:delete`);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const msg = (await readJsonBody(req)) as { method?: string; id?: number };
    const { method, id } = msg;
    if (method === "initialize") {
      opts.events.push(`${opts.label}:initialize`);
      await opts.onInitialize?.();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "MCP-Session-Id": `mock-${opts.label}`,
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION_STREAMABLE,
            capabilities: {},
            serverInfo: { name: opts.label, version: "1" },
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
      opts.events.push(`${opts.label}:tools`);
      opts.onToolsList?.();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          opts.failToolsList
            ? { jsonrpc: "2.0", id, error: { code: -32603, message: "tools/list exploded" } }
            : {
                jsonrpc: "2.0",
                id,
                result: {
                  tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
                },
              },
        ),
      );
      return;
    }
    res.writeHead(400).end();
  });

  const url: string = await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(`http://127.0.0.1:${addr.port}/mcp`);
      else reject(new Error("addr"));
    });
    server.on("error", reject);
  });
  return { url, close: () => void server.close() };
}

describe("connectShoggothMcpServers — parallel startup", () => {
  it("starts every configured server before any can respond", async () => {
    const events: string[] = [];
    let arrivals = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each server's initialize handler blocks until BOTH servers have started.
    // A sequential implementation could never satisfy this barrier; a parallel
    // one does, so this test deadlocks (and fails) if startup regresses.
    const waitForBoth = async (): Promise<void> => {
      arrivals++;
      if (arrivals >= 2) release();
      await allStarted;
    };
    const a = await startMockMcpHttp({ label: "alpha", events, onInitialize: waitForBoth });
    const b = await startMockMcpHttp({ label: "beta", events, onInitialize: waitForBoth });
    let connected: Awaited<ReturnType<typeof connectShoggothMcpServers>> | undefined;
    try {
      connected = await connectShoggothMcpServers([
        { id: "alpha", transport: "http", url: a.url },
        { id: "beta", transport: "http", url: b.url },
      ]);
      assert.ok(arrivals >= 2, "both servers were started before either responded");
      assert.ok(events.includes("alpha:initialize"));
      assert.ok(events.includes("beta:initialize"));
      assert.deepEqual(connected.statuses, [
        { id: "alpha", ok: true, attempts: 1 },
        { id: "beta", ok: true, attempts: 1 },
      ]);
      assert.deepEqual(
        connected.pool.externalSources.map((s) => s.sourceId),
        ["alpha", "beta"],
      );
    } finally {
      await connected?.pool.close().catch(() => {});
      a.close();
      b.close();
    }
  });

  it("preserves config order when a later server connects first", async () => {
    const events: string[] = [];
    let fastServedTools!: () => void;
    const fastDone = new Promise<void>((resolve) => {
      fastServedTools = resolve;
    });
    // The first-configured server holds its initialize response until the
    // second-configured server has served tools/list — completion order is
    // forced by an event gate, not a wall-clock race.
    const slow = await startMockMcpHttp({
      label: "slow",
      events,
      onInitialize: () => fastDone,
    });
    const fast = await startMockMcpHttp({
      label: "fast",
      events,
      onToolsList: () => fastServedTools(),
    });
    let connected: Awaited<ReturnType<typeof connectShoggothMcpServers>> | undefined;
    try {
      connected = await connectShoggothMcpServers([
        { id: "slow-first", transport: "http", url: slow.url },
        { id: "fast-second", transport: "http", url: fast.url },
      ]);
      const fastAt = events.indexOf("fast:tools");
      const slowAt = events.indexOf("slow:tools");
      assert.ok(fastAt !== -1 && slowAt !== -1, "both servers served tools/list");
      assert.ok(fastAt < slowAt, "the second-configured server completed first");
      assert.deepEqual(
        connected.pool.externalSources.map((s) => s.sourceId),
        ["slow-first", "fast-second"],
        "externalSources must follow config order, not completion order",
      );
      assert.deepEqual(
        connected.statuses?.map((s) => s.id),
        ["slow-first", "fast-second"],
      );
    } finally {
      await connected?.pool.close().catch(() => {});
      slow.close();
      fast.close();
    }
  });

  it("isolates a failing server and closes its partially-opened session", async () => {
    const events: string[] = [];
    const healthy = await startMockMcpHttp({ label: "healthy", events });
    const broken = await startMockMcpHttp({ label: "broken", events, failToolsList: true });
    let connected: Awaited<ReturnType<typeof connectShoggothMcpServers>> | undefined;
    try {
      connected = await connectShoggothMcpServers([
        { id: "healthy", transport: "http", url: healthy.url },
        { id: "broken", transport: "http", url: broken.url },
      ]);
      // The healthy server joins the pool; the broken one is skipped — no throw.
      assert.deepEqual(
        connected.pool.externalSources.map((s) => s.sourceId),
        ["healthy"],
      );
      assert.deepEqual(connected.statuses?.[0], { id: "healthy", ok: true, attempts: 1 });
      assert.equal(connected.statuses?.[1]?.id, "broken");
      assert.equal(connected.statuses?.[1]?.ok, false);
      assert.match(connected.statuses?.[1]?.error ?? "", /tools\/list exploded/);
      // The broken server's partially-opened session was closed, not leaked.
      assert.ok(events.includes("broken:delete"), "failed session must be closed");
      assert.ok(!events.includes("healthy:delete"), "healthy session must stay open");
      // Calls to the failed source report it is not connected.
      const out = await connected.external({
        sourceId: "broken",
        originalName: "echo",
        argsJson: "{}",
        toolCallId: "c1",
      });
      assert.match(out.resultJson, /mcp_source_not_connected/);
    } finally {
      await connected?.pool.close().catch(() => {});
      healthy.close();
      broken.close();
    }
  });

  it("throws an aggregate error when every configured server fails", async () => {
    await assert.rejects(
      () =>
        connectShoggothMcpServers([
          { id: "dead-one", transport: "http", url: "http://127.0.0.1:1/mcp" },
          { id: "dead-two", transport: "http", url: "http://127.0.0.1:1/mcp" },
        ]),
      (e: unknown) => {
        assert.ok(e instanceof AggregateError, "expected an AggregateError");
        assert.equal(e.errors.length, 2, "one error per failed server");
        assert.match(String(e), /dead-one/);
        assert.match(String(e), /dead-two/);
        return true;
      },
    );
  });
});
