import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadLayeredConfig } from "../src/config";

const TMP = join(import.meta.dirname ?? ".", ".tmp-config-test");

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}
function teardown() {
  rmSync(TMP, { recursive: true, force: true });
}

describe("loadLayeredConfig recursive", () => {
  it("loads JSON files from nested subdirectories in full-path order", () => {
    setup();
    try {
      mkdirSync(join(TMP, "base"), { recursive: true });
      mkdirSync(join(TMP, "dynamic"), { recursive: true });

      writeFileSync(
        join(TMP, "base", "00-main.json"),
        JSON.stringify({ logLevel: "info" }),
      );
      writeFileSync(
        join(TMP, "dynamic", "90-override.json"),
        JSON.stringify({ logLevel: "debug" }),
      );

      const cfg = loadLayeredConfig(TMP);
      assert.equal(cfg.logLevel, "debug");
    } finally {
      teardown();
    }
  });

  it("base/ files are merged before dynamic/ files", () => {
    setup();
    try {
      mkdirSync(join(TMP, "base"), { recursive: true });
      mkdirSync(join(TMP, "dynamic"), { recursive: true });

      writeFileSync(
        join(TMP, "base", "10-hitl.json"),
        JSON.stringify({
          hitl: { bypassUpTo: "safe" },
        }),
      );
      writeFileSync(
        join(TMP, "dynamic", "10-hitl.json"),
        JSON.stringify({
          hitl: { bypassUpTo: "critical" },
        }),
      );

      const cfg = loadLayeredConfig(TMP);
      assert.equal(cfg.hitl.bypassUpTo, "critical");
    } finally {
      teardown();
    }
  });

  it("works with flat config directory (no subdirectories)", () => {
    setup();
    try {
      writeFileSync(
        join(TMP, "00-main.json"),
        JSON.stringify({ logLevel: "warn" }),
      );

      const cfg = loadLayeredConfig(TMP);
      assert.equal(cfg.logLevel, "warn");
    } finally {
      teardown();
    }
  });

  it("ignores non-JSON files everywhere", () => {
    setup();
    try {
      mkdirSync(join(TMP, "base"), { recursive: true });
      mkdirSync(join(TMP, "dynamic"), { recursive: true });
      writeFileSync(join(TMP, "base", "README.md"), "# not json");
      writeFileSync(join(TMP, "base", ".main.json.swp"), "vim swap garbage");
      writeFileSync(join(TMP, "dynamic", ".override.json.swp"), "vim swap garbage");
      writeFileSync(
        join(TMP, "base", "00-main.json"),
        JSON.stringify({ logLevel: "info" }),
      );

      const cfg = loadLayeredConfig(TMP);
      assert.equal(cfg.logLevel, "info");
    } finally {
      teardown();
    }
  });

  it("throws on invalid JSON in non-dynamic directories", () => {
    setup();
    try {
      mkdirSync(join(TMP, "base"), { recursive: true });

      writeFileSync(
        join(TMP, "base", "00-main.json"),
        JSON.stringify({ logLevel: "info" }),
      );
      writeFileSync(join(TMP, "base", "01-bad.json"), "{not valid json!!!");

      assert.throws(
        () => loadLayeredConfig(TMP),
        (err: Error) => err.message.includes("Invalid JSON") && err.message.includes("01-bad.json"),
      );
    } finally {
      teardown();
    }
  });

  it("skips invalid JSON in dynamic/ directory and continues loading", () => {
    setup();
    try {
      mkdirSync(join(TMP, "dynamic"), { recursive: true });

      writeFileSync(
        join(TMP, "dynamic", "00-good.json"),
        JSON.stringify({ logLevel: "info" }),
      );
      writeFileSync(join(TMP, "dynamic", "01-bad.json"), "{not valid json!!!");
      writeFileSync(
        join(TMP, "dynamic", "02-override.json"),
        JSON.stringify({ logLevel: "debug" }),
      );

      const cfg = loadLayeredConfig(TMP);
      assert.equal(cfg.logLevel, "debug");
    } finally {
      teardown();
    }
  });

  it("skips dynamic/ files with invalid schema and continues loading", () => {
    setup();
    try {
      mkdirSync(join(TMP, "dynamic"), { recursive: true });

      writeFileSync(
        join(TMP, "dynamic", "00-good.json"),
        JSON.stringify({ logLevel: "info" }),
      );
      // Valid JSON but invalid schema (logLevel must be a known string)
      writeFileSync(
        join(TMP, "dynamic", "01-bad-schema.json"),
        JSON.stringify({ logLevel: 12345 }),
      );
      writeFileSync(
        join(TMP, "dynamic", "02-override.json"),
        JSON.stringify({ logLevel: "debug" }),
      );

      const cfg = loadLayeredConfig(TMP);
      assert.equal(cfg.logLevel, "debug");
    } finally {
      teardown();
    }
  });
});
