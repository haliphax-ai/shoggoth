import { describe, test, expect } from "vitest";
import { parseShoggothPluginBag, resolvePluginMeta } from "../src/shoggoth-manifest";

describe("parseShoggothPluginBag", () => {
  test("accepts valid bag with kind and entrypoint", () => {
    const bag = parseShoggothPluginBag({
      kind: "messaging-platform",
      entrypoint: "./src/plugin.ts",
    });
    expect(bag.kind).toBe("messaging-platform");
    expect(bag.entrypoint).toBe("./src/plugin.ts");
  });

  test("defaults kind to 'general' when omitted", () => {
    const bag = parseShoggothPluginBag({
      entrypoint: "./src/index.ts",
    });
    expect(bag.kind).toBe("general");
    expect(bag.entrypoint).toBe("./src/index.ts");
  });

  test("accepts kind 'observability'", () => {
    const bag = parseShoggothPluginBag({
      kind: "observability",
      entrypoint: "./src/obs.ts",
    });
    expect(bag.kind).toBe("observability");
  });

  test("throws when entrypoint is missing", () => {
    expect(() => parseShoggothPluginBag({ kind: "general" })).toThrow();
  });

  test("throws when entrypoint is empty string", () => {
    expect(() => parseShoggothPluginBag({ kind: "general", entrypoint: "" })).toThrow();
  });

  test("rejects unknown keys (strict)", () => {
    expect(() =>
      parseShoggothPluginBag({
        kind: "general",
        entrypoint: "./index.ts",
        extra: true,
      }),
    ).toThrow();
  });

  test("throws on null input", () => {
    expect(() => parseShoggothPluginBag(null)).toThrow();
  });

  test("throws on undefined input", () => {
    expect(() => parseShoggothPluginBag(undefined)).toThrow();
  });
});

describe("resolvePluginMeta", () => {
  test("combines top-level name/version with shoggothPlugin bag", () => {
    const meta = resolvePluginMeta({
      name: "@shoggoth/platform-discord",
      version: "0.1.0",
      shoggothPlugin: {
        kind: "messaging-platform",
        entrypoint: "./src/plugin.ts",
      },
    });
    expect(meta.name).toBe("@shoggoth/platform-discord");
    expect(meta.version).toBe("0.1.0");
    expect(meta.kind).toBe("messaging-platform");
    expect(meta.entrypoint).toBe("./src/plugin.ts");
  });

  test("defaults kind to 'general' when bag omits it", () => {
    const meta = resolvePluginMeta({
      name: "my-plugin",
      version: "1.0.0",
      shoggothPlugin: {
        entrypoint: "./index.ts",
      },
    });
    expect(meta.kind).toBe("general");
  });

  test("throws when shoggothPlugin bag is missing", () => {
    expect(() =>
      resolvePluginMeta({
        name: "my-plugin",
        version: "1.0.0",
      }),
    ).toThrow();
  });

  test("throws when top-level name is missing", () => {
    expect(() =>
      resolvePluginMeta({
        version: "1.0.0",
        shoggothPlugin: { entrypoint: "./index.ts" },
      }),
    ).toThrow();
  });

  test("throws when top-level version is missing", () => {
    expect(() =>
      resolvePluginMeta({
        name: "my-plugin",
        shoggothPlugin: { entrypoint: "./index.ts" },
      }),
    ).toThrow();
  });
});
