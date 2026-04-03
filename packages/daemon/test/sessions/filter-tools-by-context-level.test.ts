import { describe, it } from "vitest";
import assert from "node:assert";
import { defaultConfig } from "@shoggoth/shared";
import type { AggregatedTool } from "@shoggoth/mcp-integration";
import { filterToolsByContextLevel } from "../../src/sessions/session-mcp-tool-context";

const base = defaultConfig("/tmp/cfg");

/** Helper to create a minimal AggregatedTool stub. */
function tool(namespacedName: string, sourceId = "builtin"): AggregatedTool {
  const originalName = namespacedName.startsWith(`${sourceId}-`)
    ? namespacedName.slice(sourceId.length + 1)
    : namespacedName;
  return {
    name: originalName,
    namespacedName,
    sourceId,
    originalName,
    description: `stub ${namespacedName}`,
    inputSchema: { type: "object", properties: {} },
  };
}

const ALL_TOOLS: readonly AggregatedTool[] = [
  tool("builtin-read"),
  tool("builtin-write"),
  tool("builtin-exec"),
  tool("builtin-subagent"),
  tool("builtin-workflow"),
  tool("builtin-session-list"),
  tool("builtin-session-send"),
  tool("builtin-session-history"),
  tool("builtin-session-spawn"),
  tool("builtin-poll"),
  tool("builtin-skills"),
  tool("external-fetch", "external"),
];

function names(tools: readonly AggregatedTool[]): string[] {
  return tools.map((t) => t.namespacedName).sort();
}

describe("filterToolsByContextLevel", () => {
  describe("level: none", () => {
    it("excludes all tools by default", () => {
      const result = filterToolsByContextLevel(ALL_TOOLS, "none");
      assert.deepStrictEqual(result, []);
    });

    it("config allow re-adds specific tools", () => {
      const cfg = {
        ...base,
        contextLevelTools: { none: { allow: ["builtin-read"] } },
      };
      const result = filterToolsByContextLevel(ALL_TOOLS, "none", cfg);
      assert.deepStrictEqual(names(result), ["builtin-read"]);
    });

    it("config exclude has no additional effect (already all excluded)", () => {
      const cfg = {
        ...base,
        contextLevelTools: { none: { exclude: ["builtin-read"] } },
      };
      const result = filterToolsByContextLevel(ALL_TOOLS, "none", cfg);
      assert.deepStrictEqual(result, []);
    });
  });

  describe("level: minimal", () => {
    const MINIMAL_EXCLUDED = [
      "builtin-session-history",
      "builtin-session-spawn",
      "builtin-session-list",
      "builtin-subagent",
      "builtin-workflow",
    ];

    it("excludes default tools", () => {
      const result = filterToolsByContextLevel(ALL_TOOLS, "minimal");
      const resultNames = names(result);
      for (const excluded of MINIMAL_EXCLUDED) {
        assert.ok(!resultNames.includes(excluded), `expected ${excluded} to be excluded`);
      }
      // Non-excluded tools should be present
      assert.ok(resultNames.includes("builtin-read"));
      assert.ok(resultNames.includes("builtin-write"));
      assert.ok(resultNames.includes("builtin-exec"));
      assert.ok(resultNames.includes("builtin-session-send"));
      assert.ok(resultNames.includes("builtin-poll"));
      assert.ok(resultNames.includes("builtin-skills"));
      assert.ok(resultNames.includes("external-fetch"));
    });

    it("config exclude adds additional exclusions", () => {
      const cfg = {
        ...base,
        contextLevelTools: { minimal: { exclude: ["builtin-exec"] } },
      };
      const result = filterToolsByContextLevel(ALL_TOOLS, "minimal", cfg);
      const resultNames = names(result);
      assert.ok(!resultNames.includes("builtin-exec"), "builtin-exec should be excluded");
      // Default exclusions still apply
      for (const excluded of MINIMAL_EXCLUDED) {
        assert.ok(!resultNames.includes(excluded), `expected ${excluded} to still be excluded`);
      }
    });

    it("config allow re-allows default-excluded tools", () => {
      const cfg = {
        ...base,
        contextLevelTools: { minimal: { allow: ["builtin-subagent"] } },
      };
      const result = filterToolsByContextLevel(ALL_TOOLS, "minimal", cfg);
      const resultNames = names(result);
      assert.ok(resultNames.includes("builtin-subagent"), "builtin-subagent should be re-allowed");
      // Other default exclusions still apply
      assert.ok(!resultNames.includes("builtin-workflow"), "builtin-workflow should still be excluded");
    });

    it("config allow and exclude together", () => {
      const cfg = {
        ...base,
        contextLevelTools: {
          minimal: {
            allow: ["builtin-workflow"],
            exclude: ["builtin-read"],
          },
        },
      };
      const result = filterToolsByContextLevel(ALL_TOOLS, "minimal", cfg);
      const resultNames = names(result);
      assert.ok(resultNames.includes("builtin-workflow"), "builtin-workflow should be re-allowed");
      assert.ok(!resultNames.includes("builtin-read"), "builtin-read should be excluded");
      assert.ok(!resultNames.includes("builtin-subagent"), "builtin-subagent should still be excluded");
    });
  });

  describe("level: light", () => {
    it("excludes nothing by default", () => {
      const result = filterToolsByContextLevel(ALL_TOOLS, "light");
      assert.strictEqual(result.length, ALL_TOOLS.length);
      assert.deepStrictEqual(names(result), names(ALL_TOOLS));
    });

    it("config exclude can restrict tools", () => {
      const cfg = {
        ...base,
        contextLevelTools: { light: { exclude: ["builtin-subagent", "external-fetch"] } },
      };
      const result = filterToolsByContextLevel(ALL_TOOLS, "light", cfg);
      const resultNames = names(result);
      assert.ok(!resultNames.includes("builtin-subagent"));
      assert.ok(!resultNames.includes("external-fetch"));
      assert.strictEqual(result.length, ALL_TOOLS.length - 2);
    });
  });

  describe("level: full", () => {
    it("excludes nothing by default", () => {
      const result = filterToolsByContextLevel(ALL_TOOLS, "full");
      assert.strictEqual(result.length, ALL_TOOLS.length);
      assert.deepStrictEqual(names(result), names(ALL_TOOLS));
    });

    it("config exclude can still restrict tools on full level", () => {
      const cfg = {
        ...base,
        contextLevelTools: { full: { exclude: ["builtin-workflow", "builtin-subagent"] } },
      };
      const result = filterToolsByContextLevel(ALL_TOOLS, "full", cfg);
      const resultNames = names(result);
      assert.ok(!resultNames.includes("builtin-workflow"));
      assert.ok(!resultNames.includes("builtin-subagent"));
      assert.strictEqual(result.length, ALL_TOOLS.length - 2);
    });

    it("config allow has no effect when nothing is excluded", () => {
      const cfg = {
        ...base,
        contextLevelTools: { full: { allow: ["builtin-read"] } },
      };
      const result = filterToolsByContextLevel(ALL_TOOLS, "full");
      assert.strictEqual(result.length, ALL_TOOLS.length);
    });
  });

  describe("no config provided", () => {
    it("works without config argument", () => {
      const result = filterToolsByContextLevel(ALL_TOOLS, "full");
      assert.strictEqual(result.length, ALL_TOOLS.length);
    });

    it("applies only defaults at minimal without config", () => {
      const result = filterToolsByContextLevel(ALL_TOOLS, "minimal");
      assert.strictEqual(result.length, ALL_TOOLS.length - 5);
    });
  });

  describe("empty tool list", () => {
    it("returns empty for any level", () => {
      assert.deepStrictEqual(filterToolsByContextLevel([], "full"), []);
      assert.deepStrictEqual(filterToolsByContextLevel([], "minimal"), []);
      assert.deepStrictEqual(filterToolsByContextLevel([], "none"), []);
    });
  });
});
