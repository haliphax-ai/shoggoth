import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { HookRegistry } from "../src/hook-registry";
import { loadPluginFromDirectory } from "../src/plugin-loader";

describe("HookRegistry", () => {
  test("runs registered handlers in registration order", async () => {
    const r = new HookRegistry();
    const out: number[] = [];
    r.register("daemon.startup", async () => {
      out.push(1);
    });
    r.register("daemon.startup", async () => {
      out.push(2);
    });
    await r.run("daemon.startup");
    assert.deepStrictEqual(out, [1, 2]);
  });
});

describe("loadPluginFromDirectory", () => {
  test("loads default export hook from manifest path", async () => {
    const root = mkdtempSync(join(tmpdir(), "sh-plug-"));
    writeFileSync(
      join(root, "shoggoth.json"),
      JSON.stringify({
        name: "t",
        version: "1.0.0",
        hooks: { "daemon.startup": "./hook.mjs" },
      }),
    );
    writeFileSync(
      join(root, "hook.mjs"),
      `let n = 0;
export default async function() { n += 1; globalThis.__shoggothHookN = n; };
`,
    );
    const reg = new HookRegistry();
    await loadPluginFromDirectory(root, reg);
    await reg.run("daemon.startup");
    assert.strictEqual((globalThis as { __shoggothHookN?: number }).__shoggothHookN, 1);
    delete (globalThis as { __shoggothHookN?: number }).__shoggothHookN;
  });
});
