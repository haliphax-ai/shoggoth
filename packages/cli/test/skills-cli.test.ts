import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  formatSkillPathLine,
  formatSkillReadJson,
  formatSkillsListJson,
  formatSkillsSearchJson,
  parseSkillsSearchArgs,
} from "../src/skills-cli";

function cfg(configDirectory: string, skills: ShoggothConfig["skills"]): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: "/tmp/x.db",
    socketPath: "/tmp/s.sock",
    workspacesRoot: "/tmp/w",
    secretsDirectory: "/tmp/s",
    inboundMediaRoot: "/tmp/m",
    configDirectory,
    hitl: {
      defaultApprovalTimeoutMs: 1,
      toolRisk: { read: "safe" },
      bypassUpTo: "safe",
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills,
    plugins: [],
  } as ShoggothConfig;
}

describe("skills-cli", () => {
  test("formatSkillsListJson includes discovered skills", () => {
    const d = mkdtempSync(join(tmpdir(), "sh-clisk-"));
    const sd = join(d, "sk");
    mkdirSync(sd);
    writeFileSync(join(sd, "a.md"), "---\nid: a\ntitle: A\n---\n");
    const c = cfg(d, { scanRoots: [sd], disabledIds: [] });
    const out = JSON.parse(formatSkillsListJson(c)) as { id: string }[];
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0]!.id, "a");
  });

  test("formatSkillPathLine prints absolute path", () => {
    const d = mkdtempSync(join(tmpdir(), "sh-clisk-"));
    const sd = join(d, "sk");
    mkdirSync(sd);
    const fp = join(sd, "b.md");
    writeFileSync(fp, "---\nid: bee\n---\n");
    const c = cfg(d, { scanRoots: [sd], disabledIds: [] });
    const line = formatSkillPathLine(c, "bee").trim();
    assert.strictEqual(line, fp);
  });

  test("formatSkillReadJson returns path and content", () => {
    const d = mkdtempSync(join(tmpdir(), "sh-clisk-"));
    const sd = join(d, "sk");
    mkdirSync(sd);
    const fp = join(sd, "c.md");
    const body = "---\nid: cee\ntitle: C\n---\nHello skill";
    writeFileSync(fp, body);
    const c = cfg(d, { scanRoots: [sd], disabledIds: [] });
    const out = JSON.parse(formatSkillReadJson(c, "cee")) as {
      path: string;
      content: string;
    };
    assert.strictEqual(out.path, fp);
    assert.strictEqual(out.content, body);
  });

  test("formatSkillsSearchJson returns matching skills with metadata", () => {
    const d = mkdtempSync(join(tmpdir(), "sh-clisk-"));
    const sd = join(d, "sk");
    mkdirSync(sd);
    writeFileSync(
      join(sd, "weather.md"),
      "---\nid: weather\ntitle: Weather\ntags: [api, forecast]\ncategory: utilities\ndescription: Get weather forecasts\n---\n",
    );
    writeFileSync(
      join(sd, "github.md"),
      "---\nid: github\ntitle: GitHub\ntags: [git, ci]\ncategory: dev-tools\ndescription: GitHub operations\n---\n",
    );
    const c = cfg(d, { scanRoots: [sd], disabledIds: [] });

    // Search by query
    const byQuery = JSON.parse(formatSkillsSearchJson(c, { query: "weather" })) as {
      id: string;
      tags: string[];
      category: string | null;
      description: string | null;
      score: number;
    }[];
    assert.strictEqual(byQuery.length, 1);
    assert.strictEqual(byQuery[0]!.id, "weather");
    assert.deepStrictEqual(byQuery[0]!.tags, ["api", "forecast"]);
    assert.strictEqual(byQuery[0]!.category, "utilities");
    assert.strictEqual(byQuery[0]!.description, "Get weather forecasts");
    assert.ok(byQuery[0]!.score > 0);

    // Search by category
    const byCat = JSON.parse(formatSkillsSearchJson(c, { category: "dev-tools" })) as {
      id: string;
    }[];
    assert.strictEqual(byCat.length, 1);
    assert.strictEqual(byCat[0]!.id, "github");

    // No params returns all
    const all = JSON.parse(formatSkillsSearchJson(c)) as { id: string }[];
    assert.strictEqual(all.length, 2);
  });

  test("parseSkillsSearchArgs parses search flags", () => {
    const ok = parseSkillsSearchArgs([
      "--query",
      "weather",
      "--tag",
      "api",
      "--tag",
      "forecast",
      "--category",
      "utilities",
      "--limit",
      "5",
      "--offset",
      "2",
    ]);
    assert.ok(ok.ok);
    assert.deepStrictEqual(ok.params, {
      query: "weather",
      tags: ["api", "forecast"],
      category: "utilities",
      limit: 5,
      offset: 2,
    });

    // No flags yields empty params (search returns the full list).
    const empty = parseSkillsSearchArgs([]);
    assert.ok(empty.ok);
    if (empty.ok) assert.deepStrictEqual(empty.params, {});

    // Unknown flags are ignored.
    const unknown = parseSkillsSearchArgs(["--frobnicate", "x", "--query", "q"]);
    assert.ok(unknown.ok);
    if (unknown.ok) assert.deepStrictEqual(unknown.params, { query: "q" });
  });

  test("parseSkillsSearchArgs rejects invalid values", () => {
    const missingTagValue = parseSkillsSearchArgs(["--tag"]);
    assert.ok(!missingTagValue.ok);
    if (!missingTagValue.ok) assert.ok(missingTagValue.error.includes("--tag"));

    const badLimit = parseSkillsSearchArgs(["--limit", "0"]);
    assert.ok(!badLimit.ok);
    if (!badLimit.ok) assert.ok(badLimit.error.includes("--limit"));

    const fracLimit = parseSkillsSearchArgs(["--limit", "1.5"]);
    assert.ok(!fracLimit.ok);
    if (!fracLimit.ok) assert.ok(fracLimit.error.includes("--limit"));

    const nanLimit = parseSkillsSearchArgs(["--limit", "many"]);
    assert.ok(!nanLimit.ok);
    if (!nanLimit.ok) assert.ok(nanLimit.error.includes("--limit"));

    const badOffset = parseSkillsSearchArgs(["--offset", "-1"]);
    assert.ok(!badOffset.ok);
    if (!badOffset.ok) assert.ok(badOffset.error.includes("--offset"));
  });

  test("formatSkillsSearchJson applies limit and offset", () => {
    const d = mkdtempSync(join(tmpdir(), "sh-clisk-"));
    const sd = join(d, "sk");
    mkdirSync(sd);
    writeFileSync(join(sd, "a.md"), "---\nid: alpha\n---\n");
    writeFileSync(join(sd, "b.md"), "---\nid: beta\n---\n");
    writeFileSync(join(sd, "g.md"), "---\nid: gamma\n---\n");
    const c = cfg(d, { scanRoots: [sd], disabledIds: [] });

    const page = JSON.parse(formatSkillsSearchJson(c, { limit: 2, offset: 1 })) as {
      id: string;
      score: number;
    }[];
    assert.strictEqual(page.length, 2);
    assert.deepStrictEqual(
      page.map((r) => r.id),
      ["beta", "gamma"],
    );
    assert.ok(page.every((r) => r.score === 0));
  });
});
