import { describe, it } from "vitest";
import assert from "node:assert";
import { resolveDiscordCommandGuildIds } from "../src/config";
import type { ShoggothConfig } from "@shoggoth/shared";
import { registerPlatform, getPlatformRegistration } from "@shoggoth/messaging";
import { discordPlatformRegistration } from "../src/platform-registration";

// Route parsing drops rows when the platform URN policy is not registered.
if (!getPlatformRegistration("discord")) {
  registerPlatform(discordPlatformRegistration);
}

/** Minimal config with agent-level Discord routes (two guilds + one DM route). */
function configWithRoutes(): ShoggothConfig {
  return {
    platforms: { discord: {} },
    agents: {
      list: {
        dev: {
          platforms: {
            discord: {
              routes: [
                {
                  guildId: "g-1",
                  channelId: "111111111111111111",
                  sessionId: "agent:dev:discord:channel:111111111111111111",
                },
                {
                  guildId: "g-1",
                  channelId: "222222222222222222",
                  sessionId: "agent:dev:discord:channel:222222222222222222",
                },
                {
                  channelId: "333333333333333333",
                  sessionId: "agent:dev:discord:channel:333333333333333333",
                },
                {
                  guildId: "g-2",
                  channelId: "444444444444444444",
                  sessionId: "agent:dev:discord:channel:444444444444444444",
                },
              ],
            },
          },
        },
      },
    },
  } as unknown as ShoggothConfig;
}

describe("resolveDiscordCommandGuildIds", () => {
  it("returns unique guild IDs from routes when no explicit list is set", () => {
    assert.deepStrictEqual(resolveDiscordCommandGuildIds(configWithRoutes()), ["g-1", "g-2"]);
  });

  it("returns the explicit platforms.discord.commandGuildIds list as-is", () => {
    const cfg = configWithRoutes();
    (cfg.platforms!.discord as Record<string, unknown>).commandGuildIds = ["g-9", "g-8"];
    assert.deepStrictEqual(resolveDiscordCommandGuildIds(cfg), ["g-9", "g-8"]);
  });

  it("trims and dedupes the explicit list, dropping blanks", () => {
    const cfg = configWithRoutes();
    (cfg.platforms!.discord as Record<string, unknown>).commandGuildIds = [
      " g-9 ",
      "g-9",
      "",
      "   ",
    ];
    assert.deepStrictEqual(resolveDiscordCommandGuildIds(cfg), ["g-9"]);
  });

  it("falls back to routes when the explicit list has no usable entries", () => {
    const cfg = configWithRoutes();
    (cfg.platforms!.discord as Record<string, unknown>).commandGuildIds = ["  "];
    assert.deepStrictEqual(resolveDiscordCommandGuildIds(cfg), ["g-1", "g-2"]);
  });

  it("returns an empty array with no explicit list and no guild routes", () => {
    const cfg = {
      platforms: { discord: {} },
      agents: {
        list: {
          dev: {
            platforms: {
              discord: {
                routes: [
                  {
                    channelId: "333333333333333333",
                    sessionId: "agent:dev:discord:channel:333333333333333333",
                  },
                ],
              },
            },
          },
        },
      },
    } as unknown as ShoggothConfig;
    assert.deepStrictEqual(resolveDiscordCommandGuildIds(cfg), []);
  });
});
