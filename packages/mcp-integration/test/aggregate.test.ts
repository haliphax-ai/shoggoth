import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  aggregateMcpCatalogs,
  routeMcpToolInvocation,
  type AggregateMcpCatalogResult,
} from "../src/aggregate";
import { toMcpToolsListPayload } from "../src/advertise";
import { builtinShoggothToolsCatalog } from "../src/builtin-shoggoth-tools";

describe("aggregateMcpCatalogs", () => {
  it("namespaces tools and preserves inputSchema", () => {
    const agg = aggregateMcpCatalogs([
      builtinShoggothToolsCatalog("a"),
      {
        sourceId: "b",
        tools: [
          {
            name: "ping",
            inputSchema: {
              type: "object",
              properties: { x: { type: "number" } },
            },
          },
        ],
      },
    ]);
    assert.equal(agg.tools.length, 25);
    const read = agg.tools.find((t) => t.namespacedName === "a-read");
    assert.ok(read);
    assert.equal(read?.originalName, "read");
    // The O(1) routing index is exposed alongside the tool list.
    assert.equal(agg.toolIndex?.get("a-read"), read);
    assert.equal(agg.toolIndex?.size, agg.tools.length);
    const payload = toMcpToolsListPayload(agg);
    assert.ok(payload.tools.some((t) => t.name === "a-read" && t.inputSchema.properties));
  });

  it("rejects duplicate aggregated names", () => {
    assert.throws(() =>
      aggregateMcpCatalogs([
        {
          sourceId: "x",
          tools: [{ name: "t", inputSchema: { type: "object" } }],
        },
        {
          sourceId: "x",
          tools: [{ name: "t", inputSchema: { type: "object" } }],
        },
      ]),
    );
  });

  it("routes invocations", () => {
    const agg = aggregateMcpCatalogs([builtinShoggothToolsCatalog()]);
    const ok = routeMcpToolInvocation(agg, "builtin-read");
    assert.ok("tool" in ok);
    if ("tool" in ok) assert.equal(ok.tool.originalName, "read");
    const bad = routeMcpToolInvocation(agg, "builtin-nope");
    assert.ok("error" in bad);
  });

  it("routes hand-built results that carry no tool index", () => {
    const agg = aggregateMcpCatalogs([builtinShoggothToolsCatalog()]);
    const withoutIndex: AggregateMcpCatalogResult = { tools: agg.tools };
    const ok = routeMcpToolInvocation(withoutIndex, "builtin-read");
    assert.ok("tool" in ok);
    if ("tool" in ok) assert.equal(ok.tool.originalName, "read");
    const bad = routeMcpToolInvocation(withoutIndex, "builtin-nope");
    assert.ok("error" in bad);
  });
});
