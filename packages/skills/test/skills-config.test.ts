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
  test("listSkillsForConfig resolves absolute scan roots", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "my-skills");
    mkdirSync(skillsDir);
    writeFileSync(join(skillsDir, "one.md"), `---\nid: one\ntitle: One\n---\n`);
    const cfg = minimalConfig(cfgDir, { scanRoots: [skillsDir] });
    const list = await listSkillsForConfig(cfg);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]!.id, "one");
  });

  test("listSkillsForConfig appends workspace skills folder", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "sh-skillws-"));
    const wsSkills = join(wsDir, "skills");
    mkdirSync(wsSkills);
    writeFileSync(
      join(wsSkills, "ws-skill.md"),
      `---\nid: ws-skill\ntitle: Workspace Skill\n---\n`,
    );
    const cfg = minimalConfig("/tmp", { scanRoots: [] });
    const list = await listSkillsForConfig(cfg, wsDir);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]!.id, "ws-skill");
  });

  test("workspace skill overrides system skill with same id", async () => {
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
    const list = await listSkillsForConfig(cfg, wsDir);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]!.title, "Workspace Version");
  });

  test("skillAbsolutePathById finds file", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "s");
    mkdirSync(skillsDir);
    const p = join(skillsDir, "z.md");
    writeFileSync(p, `---\nid: zed\n---\n`);
    const cfg = minimalConfig(cfgDir, { scanRoots: [skillsDir] });
    assert.strictEqual(await skillAbsolutePathById(cfg, "zed"), p);
  });

  test("skillAbsolutePathById prefers workspace skill", async () => {
    const sysDir = mkdtempSync(join(tmpdir(), "sh-skillsys-"));
    const sysFile = join(sysDir, "x.md");
    writeFileSync(sysFile, `---\nid: x\n---\n`);
    const wsDir = mkdtempSync(join(tmpdir(), "sh-skillws-"));
    const wsSkills = join(wsDir, "skills");
    mkdirSync(wsSkills);
    const wsFile = join(wsSkills, "x.md");
    writeFileSync(wsFile, `---\nid: x\n---\n`);
    const cfg = minimalConfig("/tmp", { scanRoots: [sysDir] });
    assert.strictEqual(await skillAbsolutePathById(cfg, "x", wsDir), wsFile);
  });

  test("listSkillsForConfig drops skills with malformed frontmatter", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "s");
    mkdirSync(skillsDir);
    writeFileSync(
      join(skillsDir, "bad.md"),
      `---\nid: bad\ntitle: Bad\nthis line has no colon\n---\n`,
    );
    writeFileSync(join(skillsDir, "ok.md"), `---\nid: ok\ntitle: Ok\n---\n`);
    const cfg = minimalConfig(cfgDir, { scanRoots: [skillsDir] });
    const list = await listSkillsForConfig(cfg);
    assert.deepStrictEqual(
      list.map((s) => s.id),
      ["ok"],
    );
  });

  test("skillAbsolutePathById does not resolve malformed-frontmatter skills", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "s");
    mkdirSync(skillsDir);
    writeFileSync(join(skillsDir, "bad.md"), `---\nid: bad\ncolonless\n---\n`);
    const cfg = minimalConfig(cfgDir, { scanRoots: [skillsDir] });
    assert.strictEqual(await skillAbsolutePathById(cfg, "bad"), undefined);
  });

  test("skillAbsolutePathById still resolves disabled skills by path", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sh-skillcfg-"));
    const skillsDir = join(cfgDir, "s");
    mkdirSync(skillsDir);
    const p = join(skillsDir, "d.md");
    writeFileSync(p, `---\nid: d\n---\n`);
    const cfg = minimalConfig(cfgDir, { scanRoots: [skillsDir], disabledIds: ["d"] });
    assert.strictEqual(await skillAbsolutePathById(cfg, "d"), p);
  });
});
