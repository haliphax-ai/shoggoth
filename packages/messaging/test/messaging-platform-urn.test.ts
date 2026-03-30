import { describe, it } from "node:test";
import assert from "node:assert";
import {
  formatAgentSessionUrn,
  parseAgentSessionUrn,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  SHOGGOTH_READINESS_GUILD_SESSION_UUID,
} from "@shoggoth/shared";
import {
  assertDiscordRoutesDefaultPrimaryUuidMatchesAgent,
  checkDiscordMessagingRouteSessionUrn,
  parseFirstDiscordChannelIdFromRoutesJson,
} from "../src/discord/messaging-urn-policy";
import {
  parseFirstChannelIdFromRoutesJson,
  resolveBootstrapPrimarySessionUrn,
} from "../src/platform-urn-registry";
import { registerBuiltInMessagingPlatforms } from "../src/register-built-in-platforms";

describe("messaging platform URN registry + Discord policy", () => {
  it("registers built-in policies idempotently", () => {
    registerBuiltInMessagingPlatforms();
    registerBuiltInMessagingPlatforms();
  });

  it("assertDiscordRoutesDefaultPrimaryUuidMatchesAgent accepts URN aligned with resolved agent", () => {
    assertDiscordRoutesDefaultPrimaryUuidMatchesAgent(
      [
        {
          sessionId: formatAgentSessionUrn("main", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID),
        },
      ],
      "main",
      "discord",
    );
  });

  it("assertDiscordRoutesDefaultPrimaryUuidMatchesAgent throws when primary UUID mismatches agent id", () => {
    assert.throws(
      () =>
        assertDiscordRoutesDefaultPrimaryUuidMatchesAgent(
          [{ sessionId: "agent:wrongid:discord:00000000-0000-4000-8000-000000000001" }],
          "main",
          "discord",
        ),
      /reserved primary UUID/,
    );
  });

  it("assertDiscordRoutesDefaultPrimaryUuidMatchesAgent ignores other reserved readiness UUIDs", () => {
    assertDiscordRoutesDefaultPrimaryUuidMatchesAgent(
      [
        {
          sessionId: formatAgentSessionUrn("readiness", "discord", SHOGGOTH_READINESS_GUILD_SESSION_UUID),
        },
      ],
      "main",
      "discord",
    );
  });

  it("assertDiscordRoutesDefaultPrimaryUuidMatchesAgent accepts agents.list entries for default-primary URNs", () => {
    assertDiscordRoutesDefaultPrimaryUuidMatchesAgent(
      [
        {
          sessionId: formatAgentSessionUrn("worker", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID),
        },
      ],
      "main",
      "discord",
      { agentsList: [{ id: "worker" }] },
    );
  });

  it("assertDiscordRoutesDefaultPrimaryUuidMatchesAgent rejects unlisted agent when agents.list is non-empty", () => {
    assert.throws(
      () =>
        assertDiscordRoutesDefaultPrimaryUuidMatchesAgent(
          [
            {
              sessionId: formatAgentSessionUrn("stranger", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID),
            },
          ],
          "main",
          "discord",
          { agentsList: [{ id: "worker" }] },
        ),
      /not listed in agents\.list/,
    );
  });

  it("checkDiscordMessagingRouteSessionUrn requires leaf === channelId when both snowflakes", () => {
    const ok = parseAgentSessionUrn("agent:main:discord:1487579255616573533")!;
    assert.strictEqual(checkDiscordMessagingRouteSessionUrn(ok, "1487579255616573533"), "ok");
    const bad = parseAgentSessionUrn("agent:main:discord:1487579255616579999")!;
    const r = checkDiscordMessagingRouteSessionUrn(bad, "1487579255616573533");
    assert.ok(typeof r === "object" && "fatal" in r);
  });

  it("checkDiscordMessagingRouteSessionUrn drops non-discord platform", () => {
    const p = parseAgentSessionUrn("agent:main:slack:30000000-0000-4000-8000-000000000001")!;
    assert.strictEqual(checkDiscordMessagingRouteSessionUrn(p, "c1"), "drop");
  });

  it("parseFirstDiscordChannelIdFromRoutesJson reads first channelId", () => {
    assert.strictEqual(
      parseFirstDiscordChannelIdFromRoutesJson(
        JSON.stringify([{ channelId: "1487579255616573533", sessionId: "x" }]),
      ),
      "1487579255616573533",
    );
    assert.strictEqual(parseFirstDiscordChannelIdFromRoutesJson(undefined), undefined);
  });

  it("parseFirstChannelIdFromRoutesJson delegates to registered policy", () => {
    registerBuiltInMessagingPlatforms();
    assert.strictEqual(
      parseFirstChannelIdFromRoutesJson(
        "discord",
        JSON.stringify([{ channelId: "1487579255616573533", sessionId: "x" }]),
      ),
      "1487579255616573533",
    );
    assert.strictEqual(parseFirstChannelIdFromRoutesJson("unknown", `[{"channelId":"x"}]`), undefined);
  });

  it("resolveBootstrapPrimarySessionUrn uses channel snowflake for discord when provided", () => {
    registerBuiltInMessagingPlatforms();
    assert.strictEqual(
      resolveBootstrapPrimarySessionUrn("main", "discord", {
        primaryChannelId: "1487579255616573533",
      }),
      "agent:main:discord:1487579255616573533",
    );
    assert.strictEqual(
      resolveBootstrapPrimarySessionUrn("main", "discord", {}),
      formatAgentSessionUrn("main", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID),
    );
  });
});
