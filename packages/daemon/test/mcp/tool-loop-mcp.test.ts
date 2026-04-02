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
            inputSchema: { type: "object", properties: { x: { type: "number" } } },
          },
        ],
      },
    ]);
    const tools = mcpToolsForToolLoop(aggregated);
    assert.ok(tools.some((t) => t.name === "builtin.read"));
    assert.ok(tools.some((t) => t.name === "demo_ext.noop"));

    let calls = 0;
    const model = {
      async complete() {
        if (calls++ === 0) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin.read", argsJson: '{"path":"a.txt"}' }],
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

    const row = db
      .prepare(`SELECT status FROM tool_runs WHERE id = ?`)
      .get("run-mcp-1") as { status: string } | undefined;
    assert.equal(row?.status, "completed");
    db.close();
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
      name: "other.ping",
      argsJson: "{}",
      toolCallId: "t0",
    });
    const body = JSON.parse(out.resultJson) as { error?: string; sourceId?: string };
    assert.equal(body.error, "mcp_external_transport_unavailable");
    assert.equal(body.sourceId, "other");
  });
});
