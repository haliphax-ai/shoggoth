import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import type { ShoggothConfig } from "@shoggoth/shared";
import { ShoggothPluginSystem } from "../src/plugin-system";
import { loadAllPluginsFromConfig, resolveLocalPluginPath } from "../src/load-plugins-from-config";

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
      `export default function() {
  return {
    name: "goodp",
    hooks: {
      "daemon.shutdown": async (ctx) => { globalThis.__goodPlug = 7; },
    },
  };
};
`,
    );

    const cfgDir = mkdtempSync(join(tmpdir(), "sh-cfg-"));
    const config = {
      configDirectory: cfgDir,
      plugins: [{ id: "a", path: bad }, { id: "b", path: good }],
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
    expect((globalThis as { __goodPlug?: number }).__goodPlug).toBe(7);
    delete (globalThis as { __goodPlug?: number }).__goodPlug;
  });
});
