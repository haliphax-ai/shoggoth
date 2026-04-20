import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { scanSkillDirectories } from "../src/scan-skills";

describe("scanSkillDirectories", () => {
  test("discovers markdown files and parses id and title from frontmatter", () => {
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
    const skills = scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0]!.id, "alpha");
    assert.strictEqual(skills[0]!.title, "Alpha Skill");
    assert.ok(skills[0]!.absolutePath.endsWith("alpha.md"));
    assert.strictEqual(skills[0]!.enabled, true);
  });

  test("uses path-derived id when frontmatter omits id", () => {
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
    const skills = scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 1);
    assert.ok(skills[0]!.id.includes("nest"));
    assert.ok(skills[0]!.id.includes("beta"));
    assert.strictEqual(skills[0]!.title, "Beta");
  });

  test("config disabledIds disable skills regardless of frontmatter", () => {
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
    const skills = scanSkillDirectories([root], new Set(["keep-me"]));
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0]!.enabled, false);
  });

  test("frontmatter enabled false marks skill disabled", () => {
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
    const skills = scanSkillDirectories([root], new Set());
    assert.strictEqual(skills[0]!.enabled, false);
  });

  test("parses tags from frontmatter bracket syntax", () => {
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
    const skills = scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 1);
    assert.deepStrictEqual(skills[0]!.tags, ["api", "forecast", "location"]);
  });

  test("parses category from frontmatter", () => {
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
    const skills = scanSkillDirectories([root], new Set());
    assert.strictEqual(skills[0]!.category, "dev-tools");
  });

  test("parses description from frontmatter", () => {
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
    const skills = scanSkillDirectories([root], new Set());
    assert.strictEqual(skills[0]!.description, "A skill that does things");
  });

  test("defaults tags to empty array, category and description to null", () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "bare.md"),
      `---
id: bare
title: Bare
---
`,
    );
    const skills = scanSkillDirectories([root], new Set());
    assert.deepStrictEqual(skills[0]!.tags, []);
    assert.strictEqual(skills[0]!.category, null);
    assert.strictEqual(skills[0]!.description, null);
  });

  test("parses comma-separated tags without brackets", () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "nb.md"),
      `---
id: no-brackets
tags: alpha, beta, gamma
---
`,
    );
    const skills = scanSkillDirectories([root], new Set());
    assert.deepStrictEqual(skills[0]!.tags, ["alpha", "beta", "gamma"]);
  });
});
