import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { ShoggothPluginSystem } from "../src/plugin-system";
import { loadPluginFromDirectory } from "../src/plugin-loader";

describe("loadPluginFromDirectory", () => {
  test("loads a plugin from package.json with shoggothPlugin bag and fires hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-plug-new-"));

    // Write package.json with shoggothPlugin property bag
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "test-plugin",
        version: "1.0.0",
        shoggothPlugin: {
          kind: "general",
          entrypoint: "./plugin.mjs",
        },
      }),
    );

    // Write entrypoint that exports a factory returning a plugin object with hooks
    writeFileSync(
      join(root, "plugin.mjs"),
      `export default function createPlugin() {
  return {
    name: "test-plugin",
    hooks: {
      "daemon.shutdown": async (ctx) => {
        globalThis.__testPluginShutdownReason = ctx.reason;
      },
    },
  };
};
`,
    );

    const system = new ShoggothPluginSystem();
    const meta = await loadPluginFromDirectory(root, system);

    expect(meta.name).toBe("test-plugin");
    expect(meta.version).toBe("1.0.0");
    expect(meta.kind).toBe("general");
    expect(meta.rootDir).toBe(root);

    // Fire the hook through the plugin system and verify it ran
    await system.lifecycle["daemon.shutdown"].emit({ reason: "test-shutdown" });
    expect(
      (globalThis as { __testPluginShutdownReason?: string }).__testPluginShutdownReason,
    ).toBe("test-shutdown");
    delete (globalThis as { __testPluginShutdownReason?: string }).__testPluginShutdownReason;
  });

  test("loads a plugin that directly exports a plugin object (not a factory)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-plug-direct-"));

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "direct-plugin",
        version: "2.0.0",
        shoggothPlugin: {
          entrypoint: "./plugin.mjs",
        },
      }),
    );

    writeFileSync(
      join(root, "plugin.mjs"),
      `const plugin = {
  name: "direct-plugin",
  hooks: {
    "daemon.shutdown": async (ctx) => {
      globalThis.__directPluginFired = true;
    },
  },
};
export default plugin;
`,
    );

    const system = new ShoggothPluginSystem();
    const meta = await loadPluginFromDirectory(root, system);

    expect(meta.name).toBe("direct-plugin");
    expect(meta.version).toBe("2.0.0");
    expect(meta.kind).toBe("general"); // default kind

    await system.lifecycle["daemon.shutdown"].emit({ reason: "bye" });
    expect((globalThis as { __directPluginFired?: boolean }).__directPluginFired).toBe(true);
    delete (globalThis as { __directPluginFired?: boolean }).__directPluginFired;
  });

  test("throws when package.json is missing shoggothPlugin bag", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-plug-nobag-"));

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "bad-plugin",
        version: "1.0.0",
      }),
    );

    const system = new ShoggothPluginSystem();
    await expect(loadPluginFromDirectory(root, system)).rejects.toThrow();
  });

  test("meta includes kind from shoggothPlugin bag", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-plug-kind-"));

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "obs-plugin",
        version: "0.5.0",
        shoggothPlugin: {
          kind: "observability",
          entrypoint: "./plugin.mjs",
        },
      }),
    );

    writeFileSync(
      join(root, "plugin.mjs"),
      `export default function() {
  return { name: "obs-plugin", hooks: {} };
};
`,
    );

    const system = new ShoggothPluginSystem();
    const meta = await loadPluginFromDirectory(root, system);

    expect(meta.kind).toBe("observability");
  });
});
