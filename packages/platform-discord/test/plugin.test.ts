import { describe, it, expect, vi } from "vitest";
import { createDiscordPlugin } from "../src/plugin";
import {
  defineMessagingPlatformPlugin,
  REQUIRED_MESSAGING_PLATFORM_HOOKS,
} from "@shoggoth/plugins";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("createDiscordPlugin", () => {
  it("returns a valid MessagingPlatformPlugin with name and all 4 required hooks", () => {
    const plugin = createDiscordPlugin();

    expect(plugin.name).toBe("platform-discord");
    expect(plugin.hooks).toBeDefined();

    for (const hook of REQUIRED_MESSAGING_PLATFORM_HOOKS) {
      expect(typeof plugin.hooks[hook]).toBe("function");
    }
  });

  it("passes defineMessagingPlatformPlugin validation without throwing", () => {
    const plugin = createDiscordPlugin();
    expect(() => defineMessagingPlatformPlugin(plugin)).not.toThrow();
  });

  it("platform.register hook calls ctx.registerPlatform with discordPlatformRegistration", () => {
    const plugin = createDiscordPlugin();
    const registerPlatform = vi.fn();
    const ctx = {
      config: {} as any,
      registerPlatform,
      setPlatformRuntime: vi.fn(),
    };

    plugin.hooks["platform.register"](ctx);

    expect(registerPlatform).toHaveBeenCalledTimes(1);
    // The argument should be the discordPlatformRegistration object
    const reg = registerPlatform.mock.calls[0][0];
    expect(reg).toBeDefined();
    expect(reg.platformId ?? reg.id ?? reg.name).toBeDefined();
  });

  it("health.register hook calls ctx.registerProbe", () => {
    const plugin = createDiscordPlugin();
    const registerProbe = vi.fn();
    const ctx = { registerProbe };

    plugin.hooks["health.register"](ctx);

    expect(registerProbe).toHaveBeenCalledTimes(1);
    const probe = registerProbe.mock.calls[0][0];
    expect(probe).toBeDefined();
    expect(typeof probe.name).toBe("string");
    expect(typeof probe.check).toBe("function");
  });

  it("platform.start hook exists and is async", () => {
    const plugin = createDiscordPlugin();
    expect(typeof plugin.hooks["platform.start"]).toBe("function");
    // Async functions have AsyncFunction constructor
    expect(plugin.hooks["platform.start"].constructor.name).toBe(
      "AsyncFunction",
    );
  });

  it("platform.stop hook exists and is async", () => {
    const plugin = createDiscordPlugin();
    expect(typeof plugin.hooks["platform.stop"]).toBe("function");
    expect(plugin.hooks["platform.stop"].constructor.name).toBe(
      "AsyncFunction",
    );
  });
});

describe("platform-discord package.json", () => {
  it("has a shoggothPlugin property bag with kind: messaging-platform", () => {
    const pkgPath = resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    expect(pkg.shoggothPlugin).toBeDefined();
    expect(pkg.shoggothPlugin.kind).toBe("messaging-platform");
  });
});
