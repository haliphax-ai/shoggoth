import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, vi } from "vitest";
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

  test("lowercases and validates tag format, dropping non-conforming tags", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "valid.md"),
      `---
id: tag-format
tags: [Hello, WORLD, foo-bar, a1, tag_underscore, "spa ce", foo@bar, ok-tag]
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    // Conforming tags are lowercased and kept; tags containing anything
    // outside `[a-z0-9-]` (underscore, space, @) are dropped entirely.
    assert.deepStrictEqual(skills[0]!.tags, ["hello", "world", "foo-bar", "a1", "ok-tag"]);
  });

  test("drops tags that are empty or only punctuation after normalization", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "degenerate.md"),
      `---
id: degenerate-tags
tags: [" --- ", " ", "", ok]
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.deepStrictEqual(skills[0]!.tags, ["ok"]);
  });

  test("tags value with no conforming entries yields an empty list", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "junk.md"),
      `---
id: junk-tags
tags: hello world, foo@bar
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.deepStrictEqual(skills[0]!.tags, []);
  });

  test("skips skill files with malformed frontmatter entirely", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "broken.md"),
      `---
id: broken
title: Broken Skill
this line has no colon
---
Body
`,
    );
    writeFileSync(
      join(root, "good.md"),
      `---
id: good
title: Good Skill
---
Body
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.deepStrictEqual(
      skills.map((s) => s.id),
      ["good"],
    );
  });

  test("malformed file does not shadow a valid skill with the same id", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "a.md"),
      `---
id: dup
title: Broken Version
no colon here
---
Body
`,
    );
    writeFileSync(
      join(root, "z.md"),
      `---
id: dup
title: Valid Version
---
Body
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0]!.id, "dup");
    assert.strictEqual(skills[0]!.title, "Valid Version");
  });

  test("malformed file is not resurrected by a later valid root", async () => {
    const sysDir = mkdtempSync(join(tmpdir(), "sh-skills-sys-"));
    writeFileSync(
      join(sysDir, "x.md"),
      `---
id: x
title: Broken
colonless line
---
`,
    );
    const wsDir = mkdtempSync(join(tmpdir(), "sh-skills-ws-"));
    const wsSkills = join(wsDir, "skills");
    mkdirSync(wsSkills);
    writeFileSync(join(wsSkills, "x.md"), `---\nid: x\ntitle: Valid\n---\n`);
    const skills = await scanSkillDirectories([sysDir, wsSkills], new Set());
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0]!.title, "Valid");
  });

  test("empty-key line (leading colon) is fatal for the skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "empty-key.md"),
      `---
id: empty-key
: oops
---
Body
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 0);
  });

  test("unclosed frontmatter fence is fatal for the skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(join(root, "unclosed.md"), "---\nid: unclosed\ntitle: Never Closed");
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 0);
  });

  test("skill with no frontmatter at all is still discovered", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(join(root, "plain.md"), "Just markdown body, no frontmatter.\n");
    const skills = await scanSkillDirectories([root], new Set());
    assert.strictEqual(skills.length, 1);
    assert.ok(skills[0]!.id.includes("plain"));
    assert.strictEqual(skills[0]!.title, "plain");
  });

  test("hyphenated and numeric tags are preserved", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(
      join(root, "keep.md"),
      `---
id: conforming-tags
tags: [smart-home, v2, 2024, ---]
---
`,
    );
    const skills = await scanSkillDirectories([root], new Set());
    assert.deepStrictEqual(skills[0]!.tags, ["smart-home", "v2", "2024", "---"]);
  });

  test("duplicate ids: last root wins and a warning is logged", async () => {
    const sysDir = mkdtempSync(join(tmpdir(), "sh-skills-sys-"));
    const wsDir = mkdtempSync(join(tmpdir(), "sh-skills-ws-"));
    const wsSkills = join(wsDir, "skills");
    mkdirSync(wsSkills);
    writeFileSync(join(sysDir, "shared.md"), `---\nid: shared\ntitle: System Version\n---\n`);
    writeFileSync(join(wsSkills, "shared.md"), `---\nid: shared\ntitle: Workspace Version\n---\n`);
    const seen: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      seen.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const skills = await scanSkillDirectories([sysDir, wsSkills], new Set());
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0]!.id, "shared");
      assert.strictEqual(skills[0]!.title, "Workspace Version");
      assert.ok(skills[0]!.absolutePath.startsWith(wsSkills));
      const warnings = seen.filter((line) => {
        try {
          return JSON.parse(line).msg === "duplicate skill id; last scanned wins";
        } catch {
          return false;
        }
      });
      assert.strictEqual(warnings.length, 1);
      const fields = JSON.parse(warnings[0]!);
      assert.strictEqual(fields.skillId, "shared");
      assert.strictEqual(fields.replacedPath, join(sysDir, "shared.md"));
      assert.strictEqual(fields.replacementPath, join(wsSkills, "shared.md"));
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("no duplicate ids: no warning logged", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-skills-"));
    writeFileSync(join(root, "one.md"), `---\nid: one\n---\n`);
    writeFileSync(join(root, "two.md"), `---\nid: two\n---\n`);
    const seen: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      seen.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await scanSkillDirectories([root], new Set());
      const warnings = seen.filter((line) => {
        try {
          return JSON.parse(line).msg === "duplicate skill id; last scanned wins";
        } catch {
          return false;
        }
      });
      assert.strictEqual(warnings.length, 0);
    } finally {
      writeSpy.mockRestore();
    }
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

  test("never resolves a skill with malformed frontmatter", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-findpath-"));
    const broken = join(root, "broken.md");
    writeFileSync(
      broken,
      `---
id: broken
colonless line
---
Body
`,
    );
    assert.strictEqual(await findSkillPathById([root], "broken"), undefined);
    // The path-derived id must not resolve either.
    assert.strictEqual(await findSkillPathById([root], "broken.md"), undefined);
    assert.strictEqual(await findSkillPathById([root], "any"), undefined);
  });

  test("malformed file does not block resolution of a valid later file with the same id", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-findpath-"));
    writeFileSync(join(root, "a.md"), `---\nid: dup\ncolonless\n---\n`);
    const second = join(root, "z.md");
    writeFileSync(second, `---\nid: dup\n---\n`);
    assert.strictEqual(await findSkillPathById([root], "dup"), second);
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
