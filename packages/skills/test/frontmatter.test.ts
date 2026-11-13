import assert from "node:assert";
import { describe, test } from "vitest";
import { parseBoolField, parseMarkdownFrontmatter } from "../src/frontmatter";

describe("parseMarkdownFrontmatter", () => {
  test("parses simple key/value pairs and leaves the body", () => {
    const source = `---
id: alpha
title: Alpha Skill
---

Body here
`;
    const { fields, body } = parseMarkdownFrontmatter(source);
    assert.deepStrictEqual(fields, { id: "alpha", title: "Alpha Skill" });
    assert.strictEqual(body, "Body here\n");
  });

  test("treats the entire content as body when the frontmatter fence is missing", () => {
    const source = "just some body text";
    const { fields, body } = parseMarkdownFrontmatter(source);
    assert.deepStrictEqual(fields, {});
    assert.strictEqual(body, "just some body text");
  });

  test("parses keys containing spaces", () => {
    const source = `---
my key: my value
id: spaced-key
---
Body
`;
    const { fields, body } = parseMarkdownFrontmatter(source);
    assert.strictEqual(fields["my key"], "my value");
    assert.strictEqual(fields["id"], "spaced-key");
    assert.strictEqual(body, "Body\n");
  });

  test("parses keys containing punctuation and unicode", () => {
    const source = `---
(alias): first
tags!: bang
日本語: nihongo
---
Body
`;
    const { fields } = parseMarkdownFrontmatter(source);
    assert.strictEqual(fields["(alias)"], "first");
    assert.strictEqual(fields["tags!"], "bang");
    assert.strictEqual(fields["日本語"], "nihongo");
  });

  test("does not treat a line without a colon as a key", () => {
    const source = `---
id: alpha
no colon here
also: fine
---
Body
`;
    const { fields } = parseMarkdownFrontmatter(source);
    assert.deepStrictEqual(fields, { id: "alpha", also: "fine" });
  });

  test("preserves colons in values", () => {
    const source = `---
time: 12:30
url: https://example.com/x
---
Body
`;
    const { fields } = parseMarkdownFrontmatter(source);
    assert.strictEqual(fields["time"], "12:30");
    assert.strictEqual(fields["url"], "https://example.com/x");
  });

  test("trims values and handles empty values", () => {
    const source = `---
trimmed:    padded value
empty:
tabs:\tactual tab value
---
Body
`;
    const { fields } = parseMarkdownFrontmatter(source);
    assert.strictEqual(fields["trimmed"], "padded value");
    assert.strictEqual(fields["empty"], "");
    assert.strictEqual(fields["tabs"], "actual tab value");
  });

  test("keeps the last occurrence when a key repeats", () => {
    const source = `---
id: first
id: second
---
Body
`;
    const { fields } = parseMarkdownFrontmatter(source);
    assert.strictEqual(fields["id"], "second");
  });
});

describe("parseBoolField", () => {
  test("returns the default for undefined input", () => {
    assert.strictEqual(parseBoolField(undefined, true), true);
    assert.strictEqual(parseBoolField(undefined, false), false);
  });

  test("parses recognized boolean words", () => {
    assert.strictEqual(parseBoolField("true", false), true);
    assert.strictEqual(parseBoolField("YES", false), true);
    assert.strictEqual(parseBoolField("1", false), true);
    assert.strictEqual(parseBoolField("false", true), false);
    assert.strictEqual(parseBoolField("No", true), false);
    assert.strictEqual(parseBoolField("0", true), false);
  });

  test("falls back to the default for unrecognized values", () => {
    assert.strictEqual(parseBoolField("maybe", true), true);
    assert.strictEqual(parseBoolField("", false), false);
  });
});
