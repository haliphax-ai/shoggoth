import { describe, it } from "node:test";
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
          hitl: { agentBypassUpTo: { "agent:main": "safe" } },
        }),
      );
      writeFileSync(
        join(TMP, "dynamic", "10-hitl.json"),
        JSON.stringify({
          hitl: { agentBypassUpTo: { "agent:main": "critical" } },
        }),
      );

      const cfg = loadLayeredConfig(TMP);
      assert.equal(cfg.hitl.agentBypassUpTo["agent:main"], "critical");
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

  it("ignores non-JSON files in subdirectories", () => {
    setup();
    try {
      mkdirSync(join(TMP, "base"), { recursive: true });
      writeFileSync(join(TMP, "base", "README.md"), "# not json");
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
});
