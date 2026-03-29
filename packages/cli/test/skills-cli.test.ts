import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ShoggothConfig } from "@shoggoth/shared";
import { formatSkillPathLine, formatSkillsListJson } from "../src/skills-cli";

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
      roleBypassUpTo: {},
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
});
