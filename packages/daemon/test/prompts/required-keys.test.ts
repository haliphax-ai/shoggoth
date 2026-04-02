import { describe, it } from "vitest";
import assert from "node:assert";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_PROMPT_KEYS } from "../../src/prompts/load-prompts";
import { REQUIRED_NOTICE_KEYS } from "../../src/notices/load-notices";

const daemonSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function mdKeys(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.slice(0, -".md".length))
    .sort();
}

describe("REQUIRED_PROMPT_KEYS", () => {
  const onDisk = mdKeys(join(daemonSrc, "prompts"));

  it("lists every .md file on disk", () => {
    const missing = onDisk.filter((k) => !REQUIRED_PROMPT_KEYS.includes(k));
    assert.deepStrictEqual(missing, [], `Files on disk missing from REQUIRED_PROMPT_KEYS: ${missing.join(", ")}`);
  });

  it("has no entries without a matching .md file", () => {
    const extra = [...REQUIRED_PROMPT_KEYS].filter((k) => !onDisk.includes(k));
    assert.deepStrictEqual(extra, [], `REQUIRED_PROMPT_KEYS entries with no .md file: ${extra.join(", ")}`);
  });
});

describe("REQUIRED_NOTICE_KEYS", () => {
  const onDisk = mdKeys(join(daemonSrc, "notices"));

  it("lists every .md file on disk", () => {
    const missing = onDisk.filter((k) => !REQUIRED_NOTICE_KEYS.includes(k));
    assert.deepStrictEqual(missing, [], `Files on disk missing from REQUIRED_NOTICE_KEYS: ${missing.join(", ")}`);
  });

  it("has no entries without a matching .md file", () => {
    const extra = [...REQUIRED_NOTICE_KEYS].filter((k) => !onDisk.includes(k));
    assert.deepStrictEqual(extra, [], `REQUIRED_NOTICE_KEYS entries with no .md file: ${extra.join(", ")}`);
  });
});
