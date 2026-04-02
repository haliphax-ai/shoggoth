import assert from "node:assert";
import { describe, it, beforeEach } from "vitest";
import {
  buildBuiltinOnlySessionMcpToolContext,
  openAiToolsFromCatalog,
  type SessionMcpToolContext,
} from "../../src/sessions/session-mcp-tool-context";
import type { SessionMcpContextFinalizer } from "../../src/sessions/session-mcp-runtime";
import { mcpToolsForToolLoop } from "../../src/mcp/tool-loop-mcp";
import type { AggregateMcpCatalogResult, AggregatedTool } from "@shoggoth/mcp-integration";

/**
 * Minimal pipeline runner extracted from the runtime module's `runContextFinalizers`.
 * We test the pipeline logic in isolation without needing MCP pools.
 */
function runPipeline(
  finalizers: SessionMcpContextFinalizer[],
  ctx: SessionMcpToolContext,
  sessionId: string,
): SessionMcpToolContext {
  return finalizers.reduce((c, fn) => fn(c, sessionId), ctx);
}

function makeDummyTool(name: string): AggregatedTool {
  return {
    sourceId: "test",
    originalName: name,
    namespacedName: `test.${name}`,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
  };
}

function ctxWithTools(tools: AggregatedTool[]): SessionMcpToolContext {
  const aggregated: AggregateMcpCatalogResult = { tools };
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: undefined,
  };
}

describe("context-finalizer-pipeline", () => {
  const sessionId = "urn:shoggoth:agent-session:main:discord:00000000-0000-4000-8000-000000000001";

  it("passes through with zero finalizers", () => {
    const base = buildBuiltinOnlySessionMcpToolContext();
    const result = runPipeline([], base, sessionId);
    assert.strictEqual(result, base);
  });

  it("calls finalizers in order, each receiving previous output", () => {
    const calls: number[] = [];
    const f1: SessionMcpContextFinalizer = (ctx, _sid) => {
      calls.push(1);
      return ctx;
    };
    const f2: SessionMcpContextFinalizer = (ctx, _sid) => {
      calls.push(2);
      return ctx;
    };
    const f3: SessionMcpContextFinalizer = (ctx, _sid) => {
      calls.push(3);
      return ctx;
    };
    const base = buildBuiltinOnlySessionMcpToolContext();
    runPipeline([f1, f2, f3], base, sessionId);
    assert.deepStrictEqual(calls, [1, 2, 3]);
  });

  it("each finalizer receives the output of the previous one", () => {
    const toolA = makeDummyTool("a");
    const toolB = makeDummyTool("b");

    const addA: SessionMcpContextFinalizer = (ctx, _sid) => {
      return ctxWithTools([...ctx.aggregated.tools, toolA]);
    };
    const addB: SessionMcpContextFinalizer = (ctx, _sid) => {
      assert.ok(
        ctx.aggregated.tools.some((t) => t.originalName === "a"),
        "addB should see tool added by addA",
      );
      return ctxWithTools([...ctx.aggregated.tools, toolB]);
    };

    const base = ctxWithTools([]);
    const result = runPipeline([addA, addB], base, sessionId);
    assert.equal(result.aggregated.tools.length, 2);
    assert.ok(result.aggregated.tools.some((t) => t.originalName === "a"));
    assert.ok(result.aggregated.tools.some((t) => t.originalName === "b"));
  });

  it("a finalizer can remove tools", () => {
    const toolA = makeDummyTool("a");
    const toolB = makeDummyTool("b");
    const base = ctxWithTools([toolA, toolB]);

    const removeA: SessionMcpContextFinalizer = (ctx, _sid) => {
      return ctxWithTools(ctx.aggregated.tools.filter((t) => t.originalName !== "a"));
    };

    const result = runPipeline([removeA], base, sessionId);
    assert.equal(result.aggregated.tools.length, 1);
    assert.equal(result.aggregated.tools[0].originalName, "b");
  });

  it("a finalizer can modify tool descriptions", () => {
    const tool = makeDummyTool("x");
    const base = ctxWithTools([tool]);

    const modify: SessionMcpContextFinalizer = (ctx, _sid) => {
      const tools = ctx.aggregated.tools.map((t) => ({ ...t, description: "modified" }));
      const aggregated: AggregateMcpCatalogResult = { tools };
      return {
        aggregated,
        toolsOpenAi: openAiToolsFromCatalog(aggregated),
        toolsLoop: mcpToolsForToolLoop(aggregated),
        external: ctx.external,
      };
    };

    const result = runPipeline([modify], base, sessionId);
    assert.equal(result.aggregated.tools[0].description, "modified");
  });

  it("passes sessionId to every finalizer", () => {
    const seen: string[] = [];
    const spy: SessionMcpContextFinalizer = (ctx, sid) => {
      seen.push(sid);
      return ctx;
    };
    const base = ctxWithTools([]);
    runPipeline([spy, spy], base, "my-session");
    assert.deepStrictEqual(seen, ["my-session", "my-session"]);
  });
});
