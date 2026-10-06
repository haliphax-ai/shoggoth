/**
 * `notifications/tools/list_changed` handling in connectShoggothMcpServers:
 * the pool re-fetches `tools/list` and replaces the source's catalog entry
 * in place (same array identity, config order preserved), coalesces bursts of
 * notifications into one follow-up fetch, and keeps the previous catalog when
 * a refresh fails.
 */
import { MCP_PROTOCOL_VERSION_STDIO, type McpSourceCatalog } from "@shoggoth/mcp-integration";
import type { ShoggothMcpServerEntry } from "@shoggoth/shared";
import assert from "node:assert";
import { createServer, type Socket } from "node:net";
import { describe, it, vi, afterEach } from "vitest";
import { connectShoggothMcpServers, type McpServerPool } from "../../src/mcp/mcp-server-pool";

type FakeMcp = {
  readonly port: number;
  readonly toolsListCalls: () => number;
  readonly setTools: (names: readonly string[]) => void;
  readonly setResponseDelay: (ms: number) => void;
  readonly setFailToolsList: (fail: boolean) => void;
  readonly pushListChanged: () => void;
  readonly close: () => Promise<void>;
};

/**
 * Minimal MCP-over-TCP fake: answers initialize + tools/list, can change its
 * tool list, fail tools/list, and push `notifications/tools/list_changed` on
 * every open socket.
 */
async function startFakeMcpServer(initialTools: readonly string[]): Promise<FakeMcp> {
  const state = {
    tools: [...initialTools],
    calls: 0,
    fail: false,
    responseDelayMs: 2,
  };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; method?: string };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        const { id, method } = msg;
        if (id === undefined) continue; // client → server notification: ignore
        if (method === "initialize") {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION_STDIO,
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "fake-mcp", version: "1" },
              },
            })}\n`,
          );
        } else if (method === "tools/list") {
          state.calls += 1;
          const respond = () => {
            if (state.fail) {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32000, message: "tools/list exploded" },
                })}\n`,
              );
            } else {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    tools: state.tools.map((name) => ({
                      name,
                      description: name,
                      inputSchema: { type: "object", properties: {} },
                    })),
                  },
                })}\n`,
              );
            }
          };
          setTimeout(respond, state.responseDelayMs);
        }
        // notifications/initialized and anything else: no response
      }
    });
  });
  const port: number = await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
    server.on("error", reject);
  });
  return {
    port,
    toolsListCalls: () => state.calls,
    setTools: (names) => {
      state.tools = [...names];
    },
    setResponseDelay: (ms) => {
      state.responseDelayMs = ms;
    },
    setFailToolsList: (fail) => {
      state.fail = fail;
    },
    pushListChanged: () => {
      const line = `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: {},
      })}\n`;
      for (const s of sockets) s.write(line);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function tcpServer(id: string, port: number): ShoggothMcpServerEntry {
  return { id, transport: "tcp", host: "127.0.0.1", port };
}

function toolNames(catalog: McpSourceCatalog | undefined): string[] {
  return catalog?.tools.map((t) => t.name) ?? [];
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("pool refresh on notifications/tools/list_changed", () => {
  // Pools own a stale-cleanup interval; close them all after each test.
  let openPools: McpServerPool[] = [];
  afterEach(async () => {
    const pools = openPools;
    openPools = [];
    await Promise.all(pools.map((p) => p.close().catch(() => {})));
  });

  it("re-fetches tools/list and replaces the catalog entry in place, preserving order", async () => {
    const fakeA = await startFakeMcpServer(["alpha"]);
    const fakeB = await startFakeMcpServer(["omega"]);
    const onToolCatalogChange = vi.fn();
    try {
      const { pool, statuses } = await connectShoggothMcpServers(
        [tcpServer("a", fakeA.port), tcpServer("b", fakeB.port)],
        { onToolCatalogChange },
      );
      openPools.push(pool);

      assert.deepEqual(
        statuses?.map((s) => `${s.id}:${s.ok}`),
        ["a:true", "b:true"],
      );
      const sources = pool.externalSources;
      assert.deepEqual(
        sources.map((c) => c.sourceId),
        ["a", "b"],
      );
      assert.deepEqual(toolNames(sources[0]), ["alpha"]);
      assert.deepEqual(toolNames(sources[1]), ["omega"]);
      const entryB = sources[1];
      const callsAfterConnect = fakeA.toolsListCalls();

      fakeA.setTools(["alpha", "beta"]);
      fakeA.pushListChanged();
      await waitFor(() => toolNames(pool.externalSources[0]).length === 2);

      // Same array identity, same index, new entry object; B untouched.
      assert.strictEqual(pool.externalSources, sources);
      assert.deepEqual(
        sources.map((c) => c.sourceId),
        ["a", "b"],
      );
      assert.deepEqual(toolNames(sources[0]), ["alpha", "beta"]);
      assert.strictEqual(sources[1], entryB);
      assert.deepEqual(toolNames(sources[1]), ["omega"]);

      // Exactly one re-fetch for the source; no fetch for the other source.
      assert.equal(fakeA.toolsListCalls(), callsAfterConnect + 1);
      assert.equal(fakeB.toolsListCalls(), 1);

      // The change callback fires for the refreshed source only.
      assert.equal(onToolCatalogChange.mock.calls.length, 1);
      assert.deepEqual(onToolCatalogChange.mock.calls[0], [{ sourceId: "a" }]);
    } finally {
      await fakeA.close();
      await fakeB.close();
    }
  });

  it("coalesces a burst of notifications into exactly one follow-up fetch", async () => {
    const fake = await startFakeMcpServer(["v1"]);
    try {
      const { pool } = await connectShoggothMcpServers([tcpServer("a", fake.port)]);
      openPools.push(pool);
      const callsAfterConnect = fake.toolsListCalls();

      fake.setTools(["v2"]);
      // Slow down refreshes so the whole burst lands while the first is in flight.
      fake.setResponseDelay(50);
      for (let i = 0; i < 5; i++) fake.pushListChanged();

      await waitFor(() => fake.toolsListCalls() >= callsAfterConnect + 2);
      await waitFor(() => toolNames(pool.externalSources[0])[0] === "v2");

      // initial + first refresh + exactly one queued follow-up — nothing stacks.
      await delay(200);
      assert.equal(fake.toolsListCalls(), callsAfterConnect + 2);
      assert.deepEqual(toolNames(pool.externalSources[0]), ["v2"]);
    } finally {
      await fake.close();
    }
  });

  it("keeps the previous catalog when a refresh fails, then recovers", async () => {
    const fake = await startFakeMcpServer(["keep"]);
    try {
      const { pool } = await connectShoggothMcpServers([tcpServer("a", fake.port)]);
      openPools.push(pool);

      fake.setTools(["fresh"]);
      fake.setFailToolsList(true);
      fake.pushListChanged();
      await waitFor(() => fake.toolsListCalls() >= 2);
      await delay(100); // let the failed refresh settle

      // Failure must not blank a working catalog.
      assert.deepEqual(toolNames(pool.externalSources[0]), ["keep"]);

      // A later successful notification still refreshes normally.
      fake.setFailToolsList(false);
      fake.pushListChanged();
      await waitFor(() => toolNames(pool.externalSources[0])[0] === "fresh");
      assert.deepEqual(toolNames(pool.externalSources[0]), ["fresh"]);
    } finally {
      await fake.close();
    }
  });
});
