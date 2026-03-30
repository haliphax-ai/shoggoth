import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateMcpCatalogs,
  parseNamespacedMcpTool,
  routeMcpToolInvocation,
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
            inputSchema: { type: "object", properties: { x: { type: "number" } } },
          },
        ],
      },
    ]);
    assert.equal(agg.tools.length, 11);
    const read = agg.tools.find((t) => t.namespacedName === "a.read");
    assert.ok(read);
    assert.equal(read?.originalName, "read");
    const payload = toMcpToolsListPayload(agg);
    assert.ok(payload.tools.some((t) => t.name === "a.read" && t.inputSchema.properties));
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
    const ok = routeMcpToolInvocation(agg, "builtin.read");
    assert.ok("tool" in ok);
    if ("tool" in ok) assert.equal(ok.tool.originalName, "read");
    const bad = routeMcpToolInvocation(agg, "builtin.nope");
    assert.ok("error" in bad);
  });
});

describe("parseNamespacedMcpTool", () => {
  it("splits on first dot only", () => {
    assert.deepEqual(parseNamespacedMcpTool("canvas-web.canvas_navigate"), {
      sourceId: "canvas-web",
      toolName: "canvas_navigate",
    });
    assert.deepEqual(parseNamespacedMcpTool("a.b.c.d"), {
      sourceId: "a",
      toolName: "b.c.d",
    });
    assert.equal(parseNamespacedMcpTool("nodot"), null);
  });
});
