import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { ShoggothPluginSystem } from "../src/plugin-system";
import { loadPluginFromDirectory } from "../src/plugin-loader";
import { pluginTestStore, pluginTestStoreUrl } from "./plugin-test-store.mjs";

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
      `import { pluginTestStore } from ${JSON.stringify(pluginTestStoreUrl)};
export default function createPlugin() {
  return {
    name: "test-plugin",
    hooks: {
      "daemon.shutdown": async (ctx) => {
        pluginTestStore.set("shutdownReason", ctx.reason);
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
    expect(pluginTestStore.get("shutdownReason")).toBe("test-shutdown");
    pluginTestStore.delete("shutdownReason");
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
      `import { pluginTestStore } from ${JSON.stringify(pluginTestStoreUrl)};
const plugin = {
  name: "direct-plugin",
  hooks: {
    "daemon.shutdown": async (ctx) => {
      pluginTestStore.set("directPluginFired", true);
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
    expect(pluginTestStore.get("directPluginFired")).toBe(true);
    pluginTestStore.delete("directPluginFired");
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
