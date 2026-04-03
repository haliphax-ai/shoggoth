import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveBootstrapPrimarySessionUrn,
  parseFirstChannelIdFromRoutesJson,
} from "../src/platform-urn-registry";
import {
  registerPlatform,
  clearPlatformRegistry,
} from "../src/platform-registry";
import { SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID } from "@shoggoth/shared";

function makePolicy(platformId: string) {
  return {
    platformId,
    checkRouteSessionUrn: () => "ok" as const,
    assertRoutesDefaultPrimaryUuidMatchesAgent: () => {},
    parseFirstChannelIdFromRoutesJson: (raw: string | undefined) =>
      raw ? JSON.parse(raw).channelId : undefined,
    resolveBootstrapPrimarySessionUrn: (a: string, p: string) =>
      `agent:${a}:${p}:custom-primary`,
  };
}

describe("platform-urn-registry (via new platform-registry)", () => {
  beforeEach(() => {
    clearPlatformRegistry();
  });

  describe("resolveBootstrapPrimarySessionUrn", () => {
    it("delegates to registered platform urnPolicy", () => {
      registerPlatform({
        platformId: "test",
        resourceTypes: ["channel"],
        urnPolicy: makePolicy("test"),
      });
      const urn = resolveBootstrapPrimarySessionUrn("myagent", "test");
      expect(urn).toBe("agent:myagent:test:custom-primary");
    });

    it("falls back to default URN format for unregistered platform", () => {
      const urn = resolveBootstrapPrimarySessionUrn("myagent", "unknown");
      expect(urn).toContain("myagent");
      expect(urn).toContain("unknown");
      expect(urn).toContain(SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    });

    it("normalizes platform id case", () => {
      registerPlatform({
        platformId: "Discord",
        resourceTypes: ["channel"],
        urnPolicy: makePolicy("Discord"),
      });
      const urn = resolveBootstrapPrimarySessionUrn("a", "DISCORD");
      expect(urn).toBe("agent:a:DISCORD:custom-primary");
    });
  });

  describe("parseFirstChannelIdFromRoutesJson", () => {
    it("delegates to registered platform urnPolicy", () => {
      registerPlatform({
        platformId: "test",
        resourceTypes: ["channel"],
        urnPolicy: makePolicy("test"),
      });
      const ch = parseFirstChannelIdFromRoutesJson("test", JSON.stringify({ channelId: "ch123" }));
      expect(ch).toBe("ch123");
    });

    it("returns undefined for unregistered platform", () => {
      const ch = parseFirstChannelIdFromRoutesJson("nope", JSON.stringify({ channelId: "ch" }));
      expect(ch).toBeUndefined();
    });

    it("returns undefined when raw is undefined", () => {
      registerPlatform({
        platformId: "test",
        resourceTypes: ["channel"],
        urnPolicy: makePolicy("test"),
      });
      const ch = parseFirstChannelIdFromRoutesJson("test", undefined);
      expect(ch).toBeUndefined();
    });
  });
});
