import { describe, it, expect, afterEach, vi } from "vitest";
import { validatePlatformExtensions, type ShoggothConfig } from "@shoggoth/shared";
import { resolveDiscordBotToken } from "../src/config";

function cfg(discord: Record<string, unknown>): ShoggothConfig {
  return { platforms: { discord } } as unknown as ShoggothConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveDiscordBotToken", () => {
  it("reads the env var named by tokenEnv when configured", () => {
    vi.stubEnv("SHOGGOTH_TEST_CUSTOM_TOKEN", "env-custom");
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-default");
    const result = resolveDiscordBotToken(
      cfg({ tokenEnv: "SHOGGOTH_TEST_CUSTOM_TOKEN", token: "env-inline" }),
    );
    expect(result).toBe("env-custom");
  });

  it("prefers the tokenEnv var over DISCORD_BOT_TOKEN when both are set", () => {
    vi.stubEnv("SHOGGOTH_TEST_CUSTOM_TOKEN", "env-custom");
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-default");
    const result = resolveDiscordBotToken(cfg({ tokenEnv: "SHOGGOTH_TEST_CUSTOM_TOKEN" }));
    expect(result).toBe("env-custom");
  });

  it("falls back to DISCORD_BOT_TOKEN when tokenEnv is absent", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-default");
    const result = resolveDiscordBotToken(cfg({ token: "env-inline" }));
    expect(result).toBe("env-default");
  });

  it("falls back to the layered token when the env var is unset", () => {
    vi.stubEnv("SHOGGOTH_TEST_ABSENT_TOKEN", "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const result = resolveDiscordBotToken(
      cfg({ tokenEnv: "SHOGGOTH_TEST_ABSENT_TOKEN", token: "env-inline" }),
    );
    expect(result).toBe("env-inline");
  });

  it("falls back to the layered token when neither env var is set", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const result = resolveDiscordBotToken(cfg({ token: "env-inline" }));
    expect(result).toBe("env-inline");
  });

  it("trims whitespace from resolved values", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "  env-default  ");
    expect(resolveDiscordBotToken(cfg({}))).toBe("env-default");
  });

  it("returns undefined when nothing is configured", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    expect(resolveDiscordBotToken(cfg({}))).toBeUndefined();
  });
});

describe("discord extension validator", () => {
  it("accepts tokenEnv", () => {
    expect(validatePlatformExtensions("discord", { tokenEnv: "MY_TOKEN_VAR" })).toEqual({
      valid: true,
    });
  });

  it("accepts token and tokenEnv together", () => {
    expect(
      validatePlatformExtensions("discord", { token: "abc", tokenEnv: "MY_TOKEN_VAR" }),
    ).toEqual({ valid: true });
  });

  it("rejects an empty tokenEnv", () => {
    const result = validatePlatformExtensions("discord", { tokenEnv: "" });
    expect(result.valid).toBe(false);
  });
});
