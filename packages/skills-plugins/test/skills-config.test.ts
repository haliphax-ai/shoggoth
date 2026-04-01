import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ShoggothConfig } from "@shoggoth/shared";
import { listSkillsForConfig, skillAbsolutePathById } from "../src/skills-config";

function minimalConfig(
  configDirectory: string,
  overrides: Partial<ShoggothConfig["skills"]>,
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
      toolRisk: {},
      agentBypassUpTo: {},
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: {
      scanRoots: overrides.scanRoots ?? [],
      disabledIds: overrides.disabledIds ?? [],
    },
    plugins: [],
  } as ShoggothConfig;
}

describe("skills-config", () => {
  test("listSkillsForConfig resolves relative scan roots", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "my-skills");
    mkdirSync(skillsDir);
    writeFileSync(
      join(skillsDir, "one.md"),
      `---
id: one
title: One
---
`,
    );
    const cfg = minimalConfig(cfgDir, { scanRoots: ["my-skills"] });
    const list = listSkillsForConfig(cfg);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]!.id, "one");
  });

  test("skillAbsolutePathById finds file", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "s");
    mkdirSync(skillsDir);
    const p = join(skillsDir, "z.md");
    writeFileSync(
      p,
      `---
id: zed
---
`,
    );
    const cfg = minimalConfig(cfgDir, { scanRoots: ["s"] });
    assert.strictEqual(skillAbsolutePathById(cfg, "zed"), p);
  });
});
