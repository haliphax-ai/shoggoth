import { describe, expect, test } from "vitest";

import { definePluginWithRequiredHooks } from "../src/plugin-required-hooks";
import type { ShoggothHooks } from "../src/plugin-system";

const mkPlugin = (name: string, hooks: Partial<Record<keyof ShoggothHooks, unknown>>) =>
  ({
    name,
    hooks,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("definePluginWithRequiredHooks", () => {
  test("returns the plugin unchanged when every required hook is a function", () => {
    const plugin = mkPlugin("valid-plugin", {
      "platform.register": (_ctx: unknown) => {},
      "health.register": (_ctx: unknown) => {},
    });

    const result = definePluginWithRequiredHooks("TestPlugin", plugin, [
      "platform.register",
      "health.register",
    ]);

    expect(result).toBe(plugin);
  });

  test("throws naming the plugin kind and the missing hook", () => {
    const plugin = mkPlugin("incomplete-plugin", {
      "platform.register": (_ctx: unknown) => {},
    });

    expect(() =>
      definePluginWithRequiredHooks("TestPlugin", plugin, ["health.register"]),
    ).toThrowError(`TestPlugin "incomplete-plugin" is missing required hook "health.register"`);
  });

  test("throws on the first missing hook in requiredHooks order", () => {
    const plugin = mkPlugin("multi-missing", {});

    expect(() =>
      definePluginWithRequiredHooks("TestPlugin", plugin, ["platform.register", "platform.start"]),
    ).toThrowError(`TestPlugin "multi-missing" is missing required hook "platform.register"`);
  });

  test("throws when a required hook is present but not a function", () => {
    const plugin = mkPlugin("bad-hook-type", {
      "health.register": "not-a-function",
    });

    expect(() =>
      definePluginWithRequiredHooks("TestPlugin", plugin, ["health.register"]),
    ).toThrowError(`TestPlugin "bad-hook-type" is missing required hook "health.register"`);
  });
});
