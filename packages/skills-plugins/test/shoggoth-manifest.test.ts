import assert from "node:assert";
import { describe, test } from "node:test";
import { parseShoggothPluginManifest } from "../src/shoggoth-manifest";

describe("parseShoggothPluginManifest", () => {
  test("accepts minimal manifest", () => {
    const m = parseShoggothPluginManifest({
      name: "demo",
      version: "1.0.0",
    });
    assert.strictEqual(m.name, "demo");
    assert.strictEqual(m.version, "1.0.0");
    assert.strictEqual(m.hooks, undefined);
  });

  test("parses hooks map", () => {
    const m = parseShoggothPluginManifest({
      name: "demo",
      version: "2.0.0",
      hooks: { "daemon.startup": "./start.mjs" },
    });
    assert.strictEqual(m.hooks!["daemon.startup"], "./start.mjs");
  });

  test("rejects unknown top-level keys (strict)", () => {
    assert.throws(() =>
      parseShoggothPluginManifest({
        name: "x",
        version: "1",
        extra: true,
      } as never),
    );
  });
});
