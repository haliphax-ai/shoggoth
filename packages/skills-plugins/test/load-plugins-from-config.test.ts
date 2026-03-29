import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ShoggothConfig } from "@shoggoth/shared";
import { HookRegistry } from "../src/hook-registry";
import { loadAllPluginsFromConfig, resolveLocalPluginPath } from "../src/load-plugins-from-config";

describe("resolveLocalPluginPath", () => {
  test("returns absolute paths unchanged", () => {
    assert.strictEqual(resolveLocalPluginPath("/abs/here", "/cfg"), "/abs/here");
  });

  test("resolves relative to config directory", () => {
    const r = resolveLocalPluginPath("plugins/x", "/etc/shoggoth");
    assert.ok(r.includes("plugins"));
    assert.ok(r.endsWith(join("plugins", "x")));
  });
});

describe("loadAllPluginsFromConfig", () => {
  test("audits failure for broken manifest and still loads a second plugin", async () => {
    const bad = mkdtempSync(join(tmpdir(), "sh-bad-plug-"));
    writeFileSync(join(bad, "shoggoth.json"), "{ not json");

    const good = mkdtempSync(join(tmpdir(), "sh-good-plug-"));
    writeFileSync(
      join(good, "shoggoth.json"),
      JSON.stringify({
        name: "goodp",
        version: "1.0.0",
        hooks: { "daemon.startup": "./h.mjs" },
      }),
    );
    writeFileSync(join(good, "h.mjs"), `export default async () => { globalThis.__goodPlug = 7; };`);

    const cfgDir = mkdtempSync(join(tmpdir(), "sh-cfg-"));
    const config = {
      configDirectory: cfgDir,
      plugins: [{ id: "a", path: bad }, { id: "b", path: good }],
    } as Pick<ShoggothConfig, "plugins" | "configDirectory">;

    const audits: { outcome: string; resource: string }[] = [];
    const reg = new HookRegistry();
    const loaded = await loadAllPluginsFromConfig({
      config,
      registry: reg,
      resolveFromFile: fileURLToPath(import.meta.url),
      audit: (e) => audits.push({ outcome: e.outcome, resource: e.resource }),
    });

    assert.deepStrictEqual(loaded, [{ resource: "b", manifestName: "goodp" }]);
    assert.strictEqual(audits.length, 2);
    assert.strictEqual(audits[0]!.outcome, "failure");
    assert.strictEqual(audits[0]!.resource, "a");
    assert.strictEqual(audits[1]!.outcome, "success");
    assert.strictEqual(audits[1]!.resource, "b");

    await reg.run("daemon.startup");
    assert.strictEqual((globalThis as { __goodPlug?: number }).__goodPlug, 7);
    delete (globalThis as { __goodPlug?: number }).__goodPlug;
  });
});
