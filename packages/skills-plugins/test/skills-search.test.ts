import assert from "node:assert";
import { describe, test } from "vitest";
import type { SkillRecord } from "../src/scan-skills";
import { searchSkills } from "../src/skills-search";

/** Helper to build a minimal SkillRecord for testing. */
function skill(overrides: Partial<SkillRecord> & { id: string }): SkillRecord {
  return {
    title: overrides.title ?? overrides.id,
    absolutePath: overrides.absolutePath ?? `/skills/${overrides.id}.md`,
    enabled: overrides.enabled ?? true,
    tags: overrides.tags ?? [],
    category: overrides.category ?? null,
    description: overrides.description ?? null,
    ...overrides,
  };
}

const catalog: SkillRecord[] = [
  skill({
    id: "weather",
    title: "Weather",
    tags: ["api", "forecast", "location", "no-auth"],
    category: "utilities",
    description: "Get current weather and forecasts via wttr.in",
  }),
  skill({
    id: "nano-pdf",
    title: "Nano PDF",
    tags: ["pdf", "edit"],
    category: "utilities",
    description: "Edit PDFs with natural-language instructions",
  }),
  skill({
    id: "github",
    title: "GitHub",
    tags: ["git", "pr", "ci", "issues"],
    category: "dev-tools",
    description: "GitHub operations via gh CLI",
  }),
  skill({
    id: "mcporter",
    title: "MCP Porter",
    tags: ["mcp", "tools"],
    category: "integrations",
    description: "List, configure, auth, and call MCP servers",
  }),
  skill({
    id: "mcp-hass",
    title: "MCP Home Assistant",
    tags: ["mcp", "smart-home", "iot"],
    category: "integrations",
    description: "Control Home Assistant smart home devices",
  }),
  skill({
    id: "nano-banana-pro",
    title: "Nano Banana Pro",
    tags: ["image", "generate", "edit"],
    category: "utilities",
    description: "Generate or edit images via Gemini",
  }),
  skill({
    id: "skill-creator",
    title: "Skill Creator",
    tags: ["meta", "authoring"],
    category: "dev-tools",
    description: "Create, edit, improve, or audit AgentSkills",
  }),
];

describe("searchSkills", () => {
  test("returns all skills when no params provided", () => {
    const results = searchSkills(catalog, { limit: 100 });
    assert.strictEqual(results.length, catalog.length);
  });

  test("default limit is 10", () => {
    // With 7 items and default limit of 10, all should be returned.
    const results = searchSkills(catalog);
    assert.strictEqual(results.length, 7);
  });

  test("limit restricts result count", () => {
    const results = searchSkills(catalog, { limit: 3 });
    assert.strictEqual(results.length, 3);
  });

  test("offset paginates results", () => {
    const all = searchSkills(catalog, { limit: 100 });
    const page = searchSkills(catalog, { limit: 2, offset: 2 });
    assert.strictEqual(page.length, 2);
    assert.strictEqual(page[0]!.skill.id, all[2]!.skill.id);
    assert.strictEqual(page[1]!.skill.id, all[3]!.skill.id);
  });

  test("query matches against id", () => {
    const results = searchSkills(catalog, { query: "github", limit: 100 });
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0]!.skill.id, "github");
  });

  test("query matches against title", () => {
    const results = searchSkills(catalog, { query: "Banana", limit: 100 });
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0]!.skill.id, "nano-banana-pro");
  });

  test("query matches against description", () => {
    const results = searchSkills(catalog, { query: "forecasts", limit: 100 });
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0]!.skill.id, "weather");
  });

  test("query matches against tags", () => {
    const results = searchSkills(catalog, { query: "iot", limit: 100 });
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0]!.skill.id, "mcp-hass");
  });

  test("query is case-insensitive", () => {
    const results = searchSkills(catalog, { query: "PDF", limit: 100 });
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0]!.skill.id, "nano-pdf");
  });

  test("query with no matches returns empty", () => {
    const results = searchSkills(catalog, { query: "xyznonexistent" });
    assert.strictEqual(results.length, 0);
  });

  test("tags filter with AND logic", () => {
    const results = searchSkills(catalog, { tags: ["mcp"], limit: 100 });
    assert.strictEqual(results.length, 2);
    const ids = results.map((r) => r.skill.id).sort();
    assert.deepStrictEqual(ids, ["mcp-hass", "mcporter"]);
  });

  test("tags AND logic requires all tags present", () => {
    const results = searchSkills(catalog, { tags: ["mcp", "smart-home"], limit: 100 });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]!.skill.id, "mcp-hass");
  });

  test("tags filter with no matches returns empty", () => {
    const results = searchSkills(catalog, { tags: ["nonexistent-tag"] });
    assert.strictEqual(results.length, 0);
  });

  test("category filter", () => {
    const results = searchSkills(catalog, { category: "dev-tools", limit: 100 });
    assert.strictEqual(results.length, 2);
    const ids = results.map((r) => r.skill.id).sort();
    assert.deepStrictEqual(ids, ["github", "skill-creator"]);
  });

  test("category filter is case-insensitive", () => {
    const results = searchSkills(catalog, { category: "Dev-Tools", limit: 100 });
    assert.strictEqual(results.length, 2);
  });

  test("combined query + category", () => {
    const results = searchSkills(catalog, {
      query: "image",
      category: "utilities",
      limit: 100,
    });
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0]!.skill.id, "nano-banana-pro");
  });

  test("combined query + tags", () => {
    const results = searchSkills(catalog, {
      query: "home",
      tags: ["mcp"],
      limit: 100,
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]!.skill.id, "mcp-hass");
  });

  test("combined tags + category", () => {
    const results = searchSkills(catalog, {
      tags: ["edit"],
      category: "utilities",
      limit: 100,
    });
    const ids = results.map((r) => r.skill.id).sort();
    assert.deepStrictEqual(ids, ["nano-banana-pro", "nano-pdf"]);
  });

  test("results sorted by score descending when query provided", () => {
    // "pdf" appears in id, title, tags, and description of nano-pdf
    // but only in description for other skills (if at all)
    const results = searchSkills(catalog, { query: "pdf", limit: 100 });
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0]!.skill.id, "nano-pdf");
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1]!.score >= results[i]!.score);
    }
  });

  test("skills without tags/category still discoverable via query", () => {
    const bare = [
      skill({ id: "plain", title: "Plain Skill", description: "A simple skill" }),
    ];
    const results = searchSkills(bare, { query: "plain" });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]!.skill.id, "plain");
  });

  test("empty query/tags/category returns all (backward-compatible)", () => {
    const results = searchSkills(catalog, {
      query: null,
      tags: [],
      category: null,
      limit: 100,
    });
    assert.strictEqual(results.length, catalog.length);
  });
});
