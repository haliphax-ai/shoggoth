import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import type { ShoggothConfig } from "@shoggoth/shared";
import { ShoggothPluginSystem } from "../src/plugin-system";
import {
  loadAllPluginsFromConfig,
  resolveLocalPluginPath,
  resolveNpmPluginRoot,
} from "../src/load-plugins-from-config";
import { pluginTestStore, pluginTestStoreUrl } from "./plugin-test-store.mjs";

describe("resolveLocalPluginPath", () => {
  test("returns absolute paths unchanged", () => {
    expect(resolveLocalPluginPath("/abs/here", "/cfg")).toBe("/abs/here");
  });

  test("resolves relative to config directory", () => {
    const r = resolveLocalPluginPath("plugins/x", "/etc/shoggoth");
    expect(r).toContain("plugins");
    expect(r).toMatch(/plugins\/x$/);
  });
});

describe("resolveNpmPluginRoot", () => {
  test("throws descriptive error for missing package", () => {
    expect(() =>
      resolveNpmPluginRoot(
        "@shoggoth/definitely-not-installed-plugin",
        fileURLToPath(import.meta.url),
      ),
    ).toThrow(/^Failed to resolve npm plugin "@shoggoth\/definitely-not-installed-plugin": /);
  });
});

describe("loadAllPluginsFromConfig", () => {
  test("audits failure for broken package.json and still loads a second plugin", async () => {
    // Bad plugin: invalid package.json
    const bad = mkdtempSync(join(tmpdir(), "sh-bad-plug-"));
    writeFileSync(join(bad, "package.json"), "{ not json");

    // Good plugin: valid package.json with shoggothPlugin bag + entrypoint
    const good = mkdtempSync(join(tmpdir(), "sh-good-plug-"));
    writeFileSync(
      join(good, "package.json"),
      JSON.stringify({
        name: "goodp",
        version: "1.0.0",
        shoggothPlugin: {
          entrypoint: "./plugin.mjs",
        },
      }),
    );
    writeFileSync(
      join(good, "plugin.mjs"),
      `import { pluginTestStore } from ${JSON.stringify(pluginTestStoreUrl)};
export default function() {
  return {
    name: "goodp",
    hooks: {
      "daemon.shutdown": async (ctx) => { pluginTestStore.set("goodPlug", 7); },
    },
  };
};
`,
    );

    const cfgDir = mkdtempSync(join(tmpdir(), "sh-cfg-"));
    const config = {
      configDirectory: cfgDir,
      plugins: [
        { id: "a", path: bad },
        { id: "b", path: good },
      ],
    } as Pick<ShoggothConfig, "plugins" | "configDirectory">;

    const audits: { outcome: string; resource: string }[] = [];
    const system = new ShoggothPluginSystem();
    const loaded = await loadAllPluginsFromConfig({
      config,
      system,
      resolveFromFile: fileURLToPath(import.meta.url),
      audit: (e) => audits.push({ outcome: e.outcome, resource: e.resource }),
    });

    expect(loaded).toEqual([{ resource: "b", manifestName: "goodp" }]);
    expect(audits).toHaveLength(2);
    expect(audits[0]!.outcome).toBe("failure");
    expect(audits[0]!.resource).toBe("a");
    expect(audits[1]!.outcome).toBe("success");
    expect(audits[1]!.resource).toBe("b");

    // Fire hook through the plugin system to verify the good plugin was registered
    await system.lifecycle["daemon.shutdown"].emit({ reason: "test" });
    expect(pluginTestStore.get("goodPlug")).toBe(7);
    pluginTestStore.delete("goodPlug");
  });

  test("failed load with no audit callback emits stderr warning and still loads a second plugin", async () => {
    // Bad plugin: invalid package.json
    const bad = mkdtempSync(join(tmpdir(), "sh-bad-plug-"));
    writeFileSync(join(bad, "package.json"), "{ not json");

    // Good plugin: minimal valid manifest (no hooks required)
    const good = mkdtempSync(join(tmpdir(), "sh-good2-plug-"));
    writeFileSync(
      join(good, "package.json"),
      JSON.stringify({
        name: "goodp2",
        version: "1.0.0",
        shoggothPlugin: {
          entrypoint: "./plugin.mjs",
        },
      }),
    );
    writeFileSync(
      join(good, "plugin.mjs"),
      `export default function() {
  return { name: "goodp2", hooks: {} };
};
`,
    );

    const cfgDir = mkdtempSync(join(tmpdir(), "sh-cfg-"));
    const config = {
      configDirectory: cfgDir,
      plugins: [
        { id: "a", path: bad },
        { id: "b", path: good },
      ],
    } as Pick<ShoggothConfig, "plugins" | "configDirectory">;

    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const system = new ShoggothPluginSystem();
      const loaded = await loadAllPluginsFromConfig({
        config,
        system,
        resolveFromFile: fileURLToPath(import.meta.url),
        // No audit callback: the warning is the only report of the failure.
      });

      expect(loaded).toEqual([{ resource: "b", manifestName: "goodp2" }]);
    } finally {
      process.stderr.write = origWrite;
    }

    const lines = warnings.map((w) => w.trim()).filter((w) => w.length > 0);
    const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const failed = rows.find((row) => row.level === "warn" && row.msg === "plugin load failed");
    expect(failed).toBeDefined();
    expect(failed!["plugin"]).toBe("a");
    expect(typeof failed!["detail"]).toBe("string");
  });

  test("failed load with audit callback does not duplicate the warning on stderr", async () => {
    // Bad plugin: invalid package.json
    const bad = mkdtempSync(join(tmpdir(), "sh-bad3-plug-"));
    writeFileSync(join(bad, "package.json"), "{ not json");

    const cfgDir = mkdtempSync(join(tmpdir(), "sh-cfg-"));
    const config = {
      configDirectory: cfgDir,
      plugins: [{ id: "a", path: bad }],
    } as Pick<ShoggothConfig, "plugins" | "configDirectory">;

    const audits: { outcome: string; resource: string }[] = [];
    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const system = new ShoggothPluginSystem();
      const loaded = await loadAllPluginsFromConfig({
        config,
        system,
        resolveFromFile: fileURLToPath(import.meta.url),
        audit: (e) => audits.push({ outcome: e.outcome, resource: e.resource }),
      });

      expect(loaded).toEqual([]);
      expect(audits).toEqual([{ outcome: "failure", resource: "a" }]);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(warnings).toEqual([]);
  });
});
