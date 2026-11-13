import assert from "node:assert";
import { describe, test } from "vitest";
import { parseBoolField, parseMarkdownFrontmatter } from "../src/frontmatter";
import { performance } from "node:perf_hooks";

describe("parseMarkdownFrontmatter", () => {
  test("parses simple key/value pairs and leaves the body", () => {
    const source = `---
id: alpha
title: Alpha Skill
---

Body here
`;
    const { fields, body, malformed } = parseMarkdownFrontmatter(source);
    assert.deepStrictEqual(fields, { id: "alpha", title: "Alpha Skill" });
    assert.strictEqual(body, "Body here\n");
    assert.strictEqual(malformed, false);
  });

  test("treats the entire content as body when the frontmatter fence is missing", () => {
    const source = "just some body text";
    const { fields, body, malformed } = parseMarkdownFrontmatter(source);
    assert.deepStrictEqual(fields, {});
    assert.strictEqual(body, "just some body text");
    assert.strictEqual(malformed, false);
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

  test("blank lines inside the fences are tolerated", () => {
    const source = `---
id: alpha

title: Alpha
---
Body
`;
    const { fields, malformed } = parseMarkdownFrontmatter(source);
    assert.deepStrictEqual(fields, { id: "alpha", title: "Alpha" });
    assert.strictEqual(malformed, false);
  });

  test("tolerates pathological space runs without super-linear cost", () => {
    const spaces = " ".repeat(100_000);
    const pathological = `---\n9${spaces}\n9: value\n---\nBody\n`;
    const t0 = performance.now();
    const { fields, body } = parseMarkdownFrontmatter(pathological);
    const elapsedMs = performance.now() - t0;
    assert.strictEqual(fields["9"], "value");
    assert.deepStrictEqual(Object.keys(fields), ["9"]);
    assert.strictEqual(body, "Body\n");
    // Guard against quadratic backtracking regressions (ReDoS).
    assert.ok(elapsedMs < 100, `parse took ${elapsedMs}ms`);
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

  test("handles a closing fence with no trailing newline", () => {
    const { fields, body, malformed } = parseMarkdownFrontmatter("---\nid: alpha\n---");
    assert.deepStrictEqual(fields, { id: "alpha" });
    assert.strictEqual(body, "");
    assert.strictEqual(malformed, false);
  });

  test("accepts an empty frontmatter body between the fences", () => {
    const { fields, body, malformed } = parseMarkdownFrontmatter("---\n---\nBody\n");
    assert.deepStrictEqual(fields, {});
    assert.strictEqual(body, "Body\n");
    assert.strictEqual(malformed, false);
  });

  test("preserves a multi-line body after the closing fence", () => {
    const source = `---
id: alpha
---

First paragraph.

Second paragraph.
`;
    const { fields, body, malformed } = parseMarkdownFrontmatter(source);
    assert.deepStrictEqual(fields, { id: "alpha" });
    assert.strictEqual(body, "First paragraph.\n\nSecond paragraph.\n");
    assert.strictEqual(malformed, false);
  });

  test("normalizes CRLF line endings", () => {
    const { fields, body, malformed } = parseMarkdownFrontmatter(
      "---\r\nid: alpha\r\n---\r\n\r\nBody line\r\n",
    );
    assert.deepStrictEqual(fields, { id: "alpha" });
    assert.strictEqual(body, "Body line\n");
    assert.strictEqual(malformed, false);
  });
});

describe("parseMarkdownFrontmatter malformed-line policy", () => {
  test("a line without a colon marks the frontmatter malformed", () => {
    const source = `---
id: alpha
no colon here
---
Body
`;
    const { fields, body, malformed } = parseMarkdownFrontmatter(source);
    assert.strictEqual(malformed, true);
    assert.strictEqual(fields["id"], "alpha");
    assert.strictEqual(body, "Body\n");
  });

  test("an empty key (colon at index 0) marks the frontmatter malformed", () => {
    const source = `---
id: alpha
: oops, no key
---
Body
`;
    const { malformed } = parseMarkdownFrontmatter(source);
    assert.strictEqual(malformed, true);
  });

  test("a line with only a colon marks the frontmatter malformed", () => {
    const source = `---
id: alpha
:
---
Body
`;
    const { malformed } = parseMarkdownFrontmatter(source);
    assert.strictEqual(malformed, true);
  });

  test("an unclosed frontmatter fence marks the frontmatter malformed", () => {
    const source = `---
id: alpha
title: Never closed`;
    const { body, malformed } = parseMarkdownFrontmatter(source);
    assert.strictEqual(malformed, true);
    assert.strictEqual(body, "");
  });

  test("malformed does not swallow parseable fields but flags the block", () => {
    const source = `---
id: alpha
tags: [a, b]
title: Alpha
colonless
description: still parsed
---
Body
`;
    const { fields, malformed } = parseMarkdownFrontmatter(source);
    assert.strictEqual(malformed, true);
    assert.deepStrictEqual(fields, {
      id: "alpha",
      tags: "[a, b]",
      title: "Alpha",
      description: "still parsed",
    });
  });

  test("malformed frontmatter is never repaired by later valid lines", () => {
    const source = `---
id: alpha
: bad
id: good
---
Body
`;
    const { malformed } = parseMarkdownFrontmatter(source);
    assert.strictEqual(malformed, true);
  });

  test("a file with no frontmatter is never malformed", () => {
    const { malformed, body } = parseMarkdownFrontmatter("plain markdown body\n\nmore text\n");
    assert.strictEqual(malformed, false);
    assert.strictEqual(body, "plain markdown body\n\nmore text\n");
  });

  test("whitespace-only variants of the fence still close the block", () => {
    const source = `---
id: alpha
  ---
Body
`;
    const { malformed, body } = parseMarkdownFrontmatter(source);
    assert.strictEqual(malformed, false);
    assert.strictEqual(body, "Body\n");
  });
});

describe("parseBoolField", () => {
  test("returns the default for undefined input", () => {
    assert.strictEqual(parseBoolField(undefined, true), true);
    assert.strictEqual(parseBoolField(undefined, false), false);
  });

  test("parses recognized boolean words", () => {
    assert.strictEqual(parseBoolField("true", false), true);
    assert.strictEqual(parseBoolField("TRUE", false), true);
    assert.strictEqual(parseBoolField("YES", false), true);
    assert.strictEqual(parseBoolField("yes", false), true);
    assert.strictEqual(parseBoolField("1", false), true);
    assert.strictEqual(parseBoolField("false", true), false);
    assert.strictEqual(parseBoolField("FALSE", true), false);
    assert.strictEqual(parseBoolField("No", true), false);
    assert.strictEqual(parseBoolField("no", true), false);
    assert.strictEqual(parseBoolField("0", true), false);
  });

  test("falls back to the default for unrecognized values", () => {
    assert.strictEqual(parseBoolField("maybe", true), true);
    assert.strictEqual(parseBoolField("", false), false);
  });
});
