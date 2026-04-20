import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
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
      bypassUpTo: "safe",
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
  test("listSkillsForConfig resolves absolute scan roots", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "my-skills");
    mkdirSync(skillsDir);
    writeFileSync(
      join(skillsDir, "one.md"),
      `---\nid: one\ntitle: One\n---\n`,
    );
    const cfg = minimalConfig(cfgDir, { scanRoots: [skillsDir] });
    const list = listSkillsForConfig(cfg);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]!.id, "one");
  });

  test("listSkillsForConfig appends workspace skills folder", () => {
    const wsDir = mkdtempSync(join(tmpdir(), "sh-skillws-"));
    const wsSkills = join(wsDir, "skills");
    mkdirSync(wsSkills);
    writeFileSync(
      join(wsSkills, "ws-skill.md"),
      `---\nid: ws-skill\ntitle: Workspace Skill\n---\n`,
    );
    const cfg = minimalConfig("/tmp", { scanRoots: [] });
    const list = listSkillsForConfig(cfg, wsDir);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]!.id, "ws-skill");
  });

  test("workspace skill overrides system skill with same id", () => {
    const sysDir = mkdtempSync(join(tmpdir(), "sh-skillsys-"));
    writeFileSync(
      join(sysDir, "shared.md"),
      `---\nid: shared\ntitle: System Version\n---\nSystem content`,
    );
    const wsDir = mkdtempSync(join(tmpdir(), "sh-skillws-"));
    const wsSkills = join(wsDir, "skills");
    mkdirSync(wsSkills);
    writeFileSync(
      join(wsSkills, "shared.md"),
      `---\nid: shared\ntitle: Workspace Version\n---\nWorkspace content`,
    );
    const cfg = minimalConfig("/tmp", { scanRoots: [sysDir] });
    const list = listSkillsForConfig(cfg, wsDir);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]!.title, "Workspace Version");
  });

  test("skillAbsolutePathById finds file", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "s");
    mkdirSync(skillsDir);
    const p = join(skillsDir, "z.md");
    writeFileSync(
      p,
      `---\nid: zed\n---\n`,
    );
    const cfg = minimalConfig(cfgDir, { scanRoots: [skillsDir] });
    assert.strictEqual(skillAbsolutePathById(cfg, "zed"), p);
  });

  test("skillAbsolutePathById prefers workspace skill", () => {
    const sysDir = mkdtempSync(join(tmpdir(), "sh-skillsys-"));
    const sysFile = join(sysDir, "x.md");
    writeFileSync(sysFile, `---\nid: x\n---\n`);
    const wsDir = mkdtempSync(join(tmpdir(), "sh-skillws-"));
    const wsSkills = join(wsDir, "skills");
    mkdirSync(wsSkills);
    const wsFile = join(wsSkills, "x.md");
    writeFileSync(wsFile, `---\nid: x\n---\n`);
    const cfg = minimalConfig("/tmp", { scanRoots: [sysDir] });
    assert.strictEqual(skillAbsolutePathById(cfg, "x", wsDir), wsFile);
  });
});
