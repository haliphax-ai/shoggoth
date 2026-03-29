import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseDiscordRoutesJson,
  startDiscordMessagingIfConfigured,
} from "../../src/messaging/discord-bridge";
import { createLogger } from "../../src/logging";

describe("discord-bridge", () => {
  it("parseDiscordRoutesJson accepts guild and DM-style routes", () => {
    const routes = parseDiscordRoutesJson(
      JSON.stringify([
        { guildId: "g1", channelId: "c1", sessionId: "s1" },
        { channelId: "dm1", sessionId: "s2" },
      ]),
    );
    assert.equal(routes.length, 2);
    assert.equal(routes[0]!.guildId, "g1");
    assert.equal(routes[1]!.guildId, undefined);
  });

  it("parseDiscordRoutesJson rejects invalid JSON shape", () => {
    assert.throws(() => parseDiscordRoutesJson("{}"), /array/);
  });

  it("returns undefined without token", async () => {
    const log = createLogger({ component: "t", minLevel: "error" });
    const r = await startDiscordMessagingIfConfigured({
      logger: log,
      botToken: undefined,
      routesJson: '[{"channelId":"c","sessionId":"s"}]',
    });
    assert.equal(r, undefined);
  });

  it("returns undefined without routes when token set", async () => {
    const log = createLogger({ component: "t", minLevel: "error" });
    const r = await startDiscordMessagingIfConfigured({
      logger: log,
      botToken: "x",
      routesJson: undefined,
    });
    assert.equal(r, undefined);
  });

  it("starts with mocked gateway and registers outbound/streaming", async () => {
    const log = createLogger({ component: "t", minLevel: "error" });
    let stopped = false;
    const runtime = await startDiscordMessagingIfConfigured({
      logger: log,
      botToken: "token",
      routesJson: JSON.stringify([{ guildId: "g", channelId: "ch", sessionId: "sess" }]),
      deps: {
        connectGateway: async () => ({
          stop: async () => {
            stopped = true;
          },
        }),
      },
    });
    assert.ok(runtime);
    assert.equal(runtime!.routes.length, 1);
    assert.equal(runtime!.capabilities.platform, "discord");
    assert.equal(typeof runtime!.outbound.sendDiscord, "function");
    assert.ok(runtime!.streamingForSession("sess"));
    assert.equal(runtime!.streamingForSession("unknown"), undefined);
    await runtime!.stop();
    assert.equal(stopped, true);
  });
});
