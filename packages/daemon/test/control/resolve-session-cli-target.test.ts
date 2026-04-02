import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { defaultConfig, SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID } from "@shoggoth/shared";
import { resolveSessionTargetFromCliArg } from "../../src/control/resolve-session-cli-target";
import { registerBuiltInMessagingPlatforms } from "@shoggoth/platform-discord";

registerBuiltInMessagingPlatforms();

describe("resolveSessionTargetFromCliArg", () => {
  const cfg = {
    ...defaultConfig("/tmp/cfg"),
    agents: {
      list: {
        myagent: {
          platforms: { discord: { routes: [] } },
        },
        a1: {
          platforms: { discord: { routes: [] } },
        },
        dev: {
          platforms: { discord: { routes: [] } },
        },
      },
    },
  } as ReturnType<typeof defaultConfig>;

  it("returns a full session URN unchanged", () => {
    const urn = "agent:dev:discord:1111111111111111111";
    assert.equal(resolveSessionTargetFromCliArg(urn, cfg), urn);
  });

  it("resolves agent id to default-primary UUID session using agent platform bindings", () => {
    const prev = process.env.SHOGGOTH_PRIMARY_CHANNEL_ID;
    const prevRoutes = process.env.SHOGGOTH_DISCORD_ROUTES;
    try {
      delete process.env.SHOGGOTH_PRIMARY_CHANNEL_ID;
      delete process.env.SHOGGOTH_DISCORD_ROUTES;
      const out = resolveSessionTargetFromCliArg("myagent", cfg);
      assert.equal(
        out,
        `agent:myagent:discord:${SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID.toLowerCase()}`,
      );
    } finally {
      if (prev !== undefined) process.env.SHOGGOTH_PRIMARY_CHANNEL_ID = prev;
      else delete process.env.SHOGGOTH_PRIMARY_CHANNEL_ID;
      if (prevRoutes !== undefined) process.env.SHOGGOTH_DISCORD_ROUTES = prevRoutes;
      else delete process.env.SHOGGOTH_DISCORD_ROUTES;
    }
  });

  it("uses SHOGGOTH_PRIMARY_CHANNEL_ID when set", () => {
    const prev = process.env.SHOGGOTH_PRIMARY_CHANNEL_ID;
    try {
      process.env.SHOGGOTH_PRIMARY_CHANNEL_ID = "1487579255616573533";
      const out = resolveSessionTargetFromCliArg("a1", cfg);
      assert.equal(out, "agent:a1:discord:1487579255616573533");
    } finally {
      if (prev !== undefined) process.env.SHOGGOTH_PRIMARY_CHANNEL_ID = prev;
      else delete process.env.SHOGGOTH_PRIMARY_CHANNEL_ID;
    }
  });

  it("rejects invalid tokens", () => {
    assert.throws(() => resolveSessionTargetFromCliArg("", cfg), /non-empty/);
    assert.throws(() => resolveSessionTargetFromCliArg("bad:id", cfg), /not a valid session URN/);
  });

  it("throws when agent has no platform bindings", () => {
    const noPlatCfg = {
      ...defaultConfig("/tmp/cfg"),
      agents: { list: { lonely: {} } },
    } as ReturnType<typeof defaultConfig>;
    assert.throws(
      () => resolveSessionTargetFromCliArg("lonely", noPlatCfg),
      /no platform bindings configured for agent "lonely"/,
    );
  });

});
