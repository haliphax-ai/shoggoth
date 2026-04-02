import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { ShoggothConfig } from "@shoggoth/shared";
import { formatSkillPathLine, formatSkillReadJson, formatSkillsListJson, formatSkillsSearchJson } from "../src/skills-cli";

function cfg(
  configDirectory: string,
  skills: ShoggothConfig["skills"],
): ShoggothConfig {
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
    const c = cfg(d, { scanRoots: ["sk"], disabledIds: [] });
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
    const c = cfg(d, { scanRoots: ["sk"], disabledIds: [] });
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
    const c = cfg(d, { scanRoots: ["sk"], disabledIds: [] });
    const out = JSON.parse(formatSkillReadJson(c, "cee")) as { path: string; content: string };
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
    const c = cfg(d, { scanRoots: ["sk"], disabledIds: [] });

    // Search by query
    const byQuery = JSON.parse(formatSkillsSearchJson(c, { query: "weather" })) as {
      id: string; tags: string[]; category: string | null; description: string | null; score: number;
    }[];
    assert.strictEqual(byQuery.length, 1);
    assert.strictEqual(byQuery[0]!.id, "weather");
    assert.deepStrictEqual(byQuery[0]!.tags, ["api", "forecast"]);
    assert.strictEqual(byQuery[0]!.category, "utilities");
    assert.strictEqual(byQuery[0]!.description, "Get weather forecasts");
    assert.ok(byQuery[0]!.score > 0);

    // Search by category
    const byCat = JSON.parse(formatSkillsSearchJson(c, { category: "dev-tools" })) as { id: string }[];
    assert.strictEqual(byCat.length, 1);
    assert.strictEqual(byCat[0]!.id, "github");

    // No params returns all
    const all = JSON.parse(formatSkillsSearchJson(c)) as { id: string }[];
    assert.strictEqual(all.length, 2);
  });
});
