import assert from "node:assert";
import { writeFileSync, unlinkSync } from "node:fs";
import { describe, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOperatorTokenSecret } from "../../src/auth/read-operator-secret";
import type { ShoggothConfig } from "@shoggoth/shared";

describe("readOperatorTokenSecret", () => {
  it("prefers operatorTokenPath over env", () => {
    const path = join(tmpdir(), `shoggoth-op-${process.pid}-${Date.now()}.txt`);
    writeFileSync(path, "from-file\n", "utf8");
    const prev = process.env.SHOGGOTH_OPERATOR_TOKEN;
    process.env.SHOGGOTH_OPERATOR_TOKEN = "from-env";
    try {
      const cfg = {
        operatorTokenPath: path,
      } as ShoggothConfig;
      assert.strictEqual(readOperatorTokenSecret(cfg), "from-file");
    } finally {
      if (prev === undefined) delete process.env.SHOGGOTH_OPERATOR_TOKEN;
      else process.env.SHOGGOTH_OPERATOR_TOKEN = prev;
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  });
});
