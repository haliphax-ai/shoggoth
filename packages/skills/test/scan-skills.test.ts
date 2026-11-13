import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { findSkillPathById, scanSkillDirectories } from "../src/scan-skills";

describe("scanSkillDirectories", () => {
  test("discovers markdown files and parses id and title from frontmatter", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "alpha.md"),
      `---
id: alpha
title: Alpha Skill
---
Body here
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0]!.id, "alpha");
    assert.strictEqual(skills[0]!.title, "Alpha Skill");
    assert.ok(skills[0]!.absolutePath.endsWith("alpha.md"));
    assert.strictEqual(skills[0]!.enabled, true);
  });

  test("uses path-derived id when frontmatter omits id", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    const sub = join(root, "nest");
    mkdirSync(sub);
    writeFileSync(
      join(sub, "beta.md"),
      `---
title: Beta
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 1);
    assert.ok(skills[0]!.id.includes("nest"));
    assert.ok(skills[0]!.id.includes("beta"));
    assert.strictEqual(skills[0]!.title, "Beta");
  });

  test("config disabledIds disable skills regardless of frontmatter", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "x.md"),
      `---
id: keep-me
title: X
enabled: true
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set(["keep-me"]));
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0]!.enabled, false);
  });

  test("frontmatter enabled false marks skill disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "off.md"),
      `---
id: off-skill
title: Off
enabled: false
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills[0]!.enabled, false);
  });

  test("parses tags from frontmatter bracket syntax", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "tagged.md"),
      `---
id: tagged
title: Tagged Skill
tags: [api, Forecast, location]
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 1);
    assert.deepStrictEqual(skills[0]!.tags, ["api", "forecast", "location"]);
  });

  test("parses category from frontmatter", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "cat.md"),
      `---
id: categorized
title: Cat Skill
category: Dev-Tools
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills[0]!.category, "dev-tools");
  });

  test("parses description from frontmatter", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "desc.md"),
      `---
id: described
title: Described Skill
description: A skill that does things
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills[0]!.description, "A skill that does things");
  });

  test("defaults tags to empty array, category and description to null", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "bare.md"),
      `---
id: bare
title: Bare
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.deepStrictEqual(skills[0]!.tags, []);
    assert.strictEqual(skills[0]!.category, null);
    assert.strictEqual(skills[0]!.description, null);
  });

  test("parses comma-separated tags without brackets", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "nb.md"),
      `---
id: no-brackets
tags: alpha, beta, gamma
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.deepStrictEqual(skills[0]!.tags, ["alpha", "beta", "gamma"]);
  });
});

describe("findSkillPathById", () => {
  test("returns the path of the matching skill file", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-findpath-"));
    const p = join(root, "zed.md");
    writeFileSync(p, `---\nid: zed\n---\n`);
    writeFileSync(join(root, "other.md"), `---\nid: other\n---\n`);
    assert.strictEqual(await findSkillPathById([root], "zed"), p);
  });

  test("returns undefined for an unknown id", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-findpath-"));
    writeFileSync(join(root, "a.md"), `---\nid: a\n---\n`);
    assert.strictEqual(await findSkillPathById([root], "missing"), undefined);
  });

  test("matches the path-derived id when frontmatter omits id", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-findpath-"));
    const sub = join(root, "nest");
    mkdirSync(sub);
    const p = join(sub, "beta.md");
    writeFileSync(p, `---\ntitle: Beta\n---\n`);
    const slugId = (await scanSkillDirectories([root], new Set()))[0]!.id;
    assert.ok(slugId.includes("beta"));
    assert.strictEqual(await findSkillPathById([root], slugId), p);
  });

  test("prefers later roots over earlier roots for the same id", async () => {
    const sysDir = mkdtempSync(join(tmpdir(), "sh-findpath-sys-"));
    writeFileSync(join(sysDir, "shared.md"), `---\nid: shared\n---\n`);
    const wsDir = mkdtempSync(join(tmpdir(), "sh-findpath-ws-"));
    const wsSkills = join(wsDir, "skills");
    mkdirSync(wsSkills);
    writeFileSync(join(wsSkills, "shared.md"), `---\nid: shared\n---\n`);
    assert.strictEqual(
      await findSkillPathById([sysDir, wsSkills], "shared"),
      join(wsSkills, "shared.md"),
    );
  });

  test("prefers a later file over an earlier file within one root", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-findpath-"));
    const first = join(root, "a.md");
    writeFileSync(first, `---\nid: dup\n---\n`);
    const second = join(root, "z.md");
    writeFileSync(second, `---\nid: dup\n---\n`);
    assert.strictEqual(await findSkillPathById([root], "dup"), second);
  });

  test("ignores non-directory and missing roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-findpath-"));
    const p = join(root, "ok.md");
    writeFileSync(p, `---\nid: ok\n---\n`);
    assert.strictEqual(await findSkillPathById(["/definitely/not/a/dir", root], "ok"), p);
  });
});
