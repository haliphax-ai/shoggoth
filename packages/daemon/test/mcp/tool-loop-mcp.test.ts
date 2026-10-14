import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
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

describe("tool-loop MCP bridge", () => {
  it("aggregates builtin + external and routes builtin invocations", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "s1", workspacePath: "/w/s1" });
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
      correlationId: "run-mcp",
    });

    const aggregated = buildAggregatedMcpCatalog([
      {
        sourceId: "demo_ext",
        tools: [
          {
            name: "noop",
            inputSchema: {
              type: "object",
              properties: { x: { type: "number" } },
            },
          },
        ],
      },
    ]);
    const tools = mcpToolsForToolLoop(aggregated);
    assert.ok(tools.some((t) => t.name === "builtin-read"));
    assert.ok(tools.some((t) => t.name === "demo_ext-noop"));

    let calls = 0;
    const model = {
      async complete() {
        if (calls++ === 0) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-read", argsJson: '{"path":"a.txt"}' }],
          };
        }
        return { content: null, toolCalls: [] };
      },
    };

    const toolRuns = createToolRunStore(db);
    await runToolLoop({
      db,
      sessionId: "s1",
      runId: "run-mcp-1",
      principalId: "s1",
      policy,
      audit,
      model,
      tools,
      executor: createMcpRoutingToolExecutor({
        aggregated,
        builtin: async ({ originalName, argsJson }) => {
          assert.equal(originalName, "read");
          assert.match(argsJson, /a\.txt/);
          return { resultJson: JSON.stringify({ ok: true, originalName }) };
        },
      }),
      toolRuns,
    });

    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = ?`).get("run-mcp-1") as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "completed");
    db.close();
  });

  // -------------------------------------------------------------------------
  // Universal argument validation (issue #435): every dispatch path — session
  // tool loop, workflow tool tasks, subagent runtime — must reject unknown
  // arguments and missing required arguments before the tool runs.
  // -------------------------------------------------------------------------
  it("rejects unknown arguments before dispatching to the builtin delegate", async () => {
    let calls = 0;
    const ex = createMcpRoutingToolExecutor({
      aggregated: buildAggregatedMcpCatalog(),
      builtin: async () => {
        calls++;
        return { resultJson: "{}" };
      },
    });
    const out = await ex.execute({
      name: "builtin-read",
      argsJson: '{"path":"a.txt","recusrive":true}',
      toolCallId: "v1",
    });
    const body = JSON.parse(out.resultJson) as { error?: string; message?: string; tool?: string };
    assert.equal(body.error, "invalid_arguments");
    assert.equal(body.tool, "builtin-read");
    assert.match(body.message ?? "", /recusrive/);
    assert.equal(calls, 0, "builtin delegate must not run with invalid args");
  });

  it("rejects missing required arguments before dispatching to the builtin delegate", async () => {
    let calls = 0;
    const ex = createMcpRoutingToolExecutor({
      aggregated: buildAggregatedMcpCatalog(),
      builtin: async () => {
        calls++;
        return { resultJson: "{}" };
      },
    });
    const out = await ex.execute({
      name: "builtin-write",
      argsJson: '{"path":"a.txt"}',
      toolCallId: "v2",
    });
    const body = JSON.parse(out.resultJson) as { error?: string; message?: string };
    assert.equal(body.error, "invalid_arguments");
    assert.match(body.message ?? "", /content/);
    assert.equal(calls, 0, "builtin delegate must not run with invalid args");
  });

  it("rejects unknown arguments before dispatching to an external MCP tool", async () => {
    let calls = 0;
    const aggregated = buildAggregatedMcpCatalog([
      {
        sourceId: "demo_ext",
        tools: [
          {
            name: "greet",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        ],
      },
    ]);
    const ex = createMcpRoutingToolExecutor({
      aggregated,
      builtin: async () => ({ resultJson: "{}" }),
      external: async () => {
        calls++;
        return { resultJson: JSON.stringify({ ok: true }) };
      },
    });
    const out = await ex.execute({
      name: "demo_ext-greet",
      argsJson: '{"name":"rook","tmeperature":0.2}',
      toolCallId: "v3",
    });
    const body = JSON.parse(out.resultJson) as { error?: string; message?: string };
    assert.equal(body.error, "invalid_arguments");
    assert.match(body.message ?? "", /tmeperature/);
    assert.equal(calls, 0, "external transport must not be invoked with invalid args");
  });

  it("returns invalid_arguments for malformed args JSON", async () => {
    let calls = 0;
    const ex = createMcpRoutingToolExecutor({
      aggregated: buildAggregatedMcpCatalog(),
      builtin: async () => {
        calls++;
        return { resultJson: "{}" };
      },
    });
    const out = await ex.execute({
      name: "builtin-read",
      argsJson: "{not json",
      toolCallId: "v6",
    });
    const body = JSON.parse(out.resultJson) as { error?: string; message?: string };
    assert.equal(body.error, "invalid_arguments");
    assert.match(body.message ?? "", /not valid JSON/);
    assert.equal(calls, 0);
  });

  it("passes args through for open schemas (no properties declared)", async () => {
    const aggregated = buildAggregatedMcpCatalog([
      {
        sourceId: "demo_ext",
        tools: [{ name: "ping", inputSchema: { type: "object" } }],
      },
    ]);
    const ex = createMcpRoutingToolExecutor({
      aggregated,
      builtin: async () => ({ resultJson: "{}" }),
      external: async () => ({ resultJson: JSON.stringify({ pong: true }) }),
    });
    const out = await ex.execute({
      name: "demo_ext-ping",
      argsJson: '{"anything":"goes"}',
      toolCallId: "v4",
    });
    assert.deepEqual(JSON.parse(out.resultJson), { pong: true });
  });

  it("allows extra args when the schema sets additionalProperties true", async () => {
    let calls = 0;
    const aggregated = buildAggregatedMcpCatalog([
      {
        sourceId: "demo_ext",
        tools: [
          {
            name: "free",
            inputSchema: {
              type: "object",
              properties: { a: { type: "string" } },
              additionalProperties: true,
            },
          },
        ],
      },
    ]);
    const ex = createMcpRoutingToolExecutor({
      aggregated,
      builtin: async () => ({ resultJson: "{}" }),
      external: async () => {
        calls++;
        return { resultJson: JSON.stringify({ ok: true }) };
      },
    });
    const out = await ex.execute({
      name: "demo_ext-free",
      argsJson: '{"a":"x","extra":1}',
      toolCallId: "v5",
    });
    assert.deepEqual(JSON.parse(out.resultJson), { ok: true });
    assert.equal(calls, 1);
  });

  it("returns structured stub when external MCP transport is not configured", async () => {
    const aggregated = buildAggregatedMcpCatalog([
      {
        sourceId: "other",
        tools: [
          {
            name: "ping",
            inputSchema: { type: "object" },
          },
        ],
      },
    ]);
    const ex = createMcpRoutingToolExecutor({
      aggregated,
      builtin: async () => ({ resultJson: "{}" }),
    });
    const out = await ex.execute({
      name: "other-ping",
      argsJson: "{}",
      toolCallId: "t0",
    });
    const body = JSON.parse(out.resultJson) as {
      error?: string;
      sourceId?: string;
    };
    assert.equal(body.error, "mcp_external_transport_unavailable");
    assert.equal(body.sourceId, "other");
  });
});

// ---------------------------------------------------------------------------
// Mid-turn MCP session lapse recovery (idle eviction closing a pooled session
// while the turn holds the captured `external` — see research
// mcp-session-lifecycle.md, recommendation #1)
// ---------------------------------------------------------------------------
describe("MCP session lapse mid-turn — reconnect and retry once", () => {
  const lapsedResult = () =>
    JSON.stringify({
      error: "mcp_tools_call_failed",
      message: "Error: MCP session is closed",
    });

  function catalog() {
    return buildAggregatedMcpCatalog([
      {
        sourceId: "demo_ext",
        tools: [{ name: "noop", inputSchema: { type: "object" } }],
      },
    ]);
  }

  it("matches the closed-session signatures produced by the transports and pool", () => {
    // Throw from request()/postOnce(): `Error: MCP session is closed`, wrapped
    // by mcp-server-pool as { error, message: String(e) }.
    assert.equal(
      isLapsedMcpSessionResult(
        JSON.stringify({
          error: "mcp_tools_call_failed",
          message: "Error: MCP session is closed",
        }),
      ),
      true,
    );
    // Pending requests failed by close(): `MCP session closed`.
    assert.equal(
      isLapsedMcpSessionResult(
        JSON.stringify({
          error: "mcp_tools_call_failed",
          message: "Error: MCP session closed",
        }),
      ),
      true,
    );
    // Other failures must not trigger a reconnect.
    assert.equal(
      isLapsedMcpSessionResult(
        JSON.stringify({
          error: "mcp_tools_call_failed",
          message: "Error: request timed out",
        }),
      ),
      false,
    );
    assert.equal(
      isLapsedMcpSessionResult(
        JSON.stringify({ error: "mcp_source_not_connected", message: "nope" }),
      ),
      false,
    );
    assert.equal(isLapsedMcpSessionResult("not json"), false);
  });

  it("reconnects and retries exactly once when the session is closed mid-turn", async () => {
    let staleCalls = 0;
    let freshCalls = 0;
    let reconnectCalls = 0;
    const ex = createMcpRoutingToolExecutor({
      aggregated: catalog(),
      builtin: async () => ({ resultJson: "{}" }),
      external: async () => {
        staleCalls++;
        return { resultJson: lapsedResult() };
      },
      reconnectExternal: async () => {
        reconnectCalls++;
        return async () => {
          freshCalls++;
          return { resultJson: JSON.stringify({ ok: true }) };
        };
      },
    });

    const out = await ex.execute({ name: "demo_ext-noop", argsJson: "{}", toolCallId: "t1" });

    assert.equal(staleCalls, 1, "stale transport used for the failing first attempt");
    assert.equal(reconnectCalls, 1, "exactly one reconnect");
    assert.equal(freshCalls, 1, "exactly one retry against the refreshed transport");
    assert.deepEqual(JSON.parse(out.resultJson), { ok: true });
  });

  it("surfaces a second closed-session failure without retrying again", async () => {
    let reconnectCalls = 0;
    let freshCalls = 0;
    const ex = createMcpRoutingToolExecutor({
      aggregated: catalog(),
      builtin: async () => ({ resultJson: "{}" }),
      external: async () => ({ resultJson: lapsedResult() }),
      reconnectExternal: async () => {
        reconnectCalls++;
        return async () => {
          freshCalls++;
          return { resultJson: lapsedResult() };
        };
      },
    });

    const out = await ex.execute({ name: "demo_ext-noop", argsJson: "{}", toolCallId: "t2" });

    assert.equal(reconnectCalls, 1, "reconnect happens at most once");
    assert.equal(freshCalls, 1, "the retry happens, but is not retried a second time");
    const body = JSON.parse(out.resultJson) as { error?: string; message?: string };
    assert.equal(body.error, "mcp_tools_call_failed");
    assert.match(body.message ?? "", /MCP session is closed/);
  });

  it("does not reconnect for non-lapse failures", async () => {
    let reconnectCalls = 0;
    const ex = createMcpRoutingToolExecutor({
      aggregated: catalog(),
      builtin: async () => ({ resultJson: "{}" }),
      external: async () => ({
        resultJson: JSON.stringify({
          error: "mcp_tools_call_failed",
          message: "Error: request timed out",
        }),
      }),
      reconnectExternal: async () => {
        reconnectCalls++;
        return async () => ({ resultJson: JSON.stringify({ ok: true }) });
      },
    });

    const out = await ex.execute({ name: "demo_ext-noop", argsJson: "{}", toolCallId: "t3" });

    assert.equal(reconnectCalls, 0, "timeouts must not trigger a reconnect");
    const body = JSON.parse(out.resultJson) as { error?: string; message?: string };
    assert.equal(body.error, "mcp_tools_call_failed");
    assert.match(body.message ?? "", /timed out/);
  });

  it("surfaces the closed-session error as-is when no reconnect is configured", async () => {
    let calls = 0;
    const ex = createMcpRoutingToolExecutor({
      aggregated: catalog(),
      builtin: async () => ({ resultJson: "{}" }),
      external: async () => {
        calls++;
        return { resultJson: lapsedResult() };
      },
    });

    const out = await ex.execute({ name: "demo_ext-noop", argsJson: "{}", toolCallId: "t4" });

    assert.equal(calls, 1, "no retry without a reconnect callback");
    assert.equal((JSON.parse(out.resultJson) as { error?: string }).error, "mcp_tools_call_failed");
  });
});
