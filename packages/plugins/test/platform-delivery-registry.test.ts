import { describe, expect, test } from "vitest";
import { PlatformDeliveryRegistry } from "../src/platform-delivery-registry";

function makeRegistry(): PlatformDeliveryRegistry {
  const registry = new PlatformDeliveryRegistry();
  registry.register("discord", {
    resolveOperatorDelivery: () => ({ kind: "messaging_surface", userId: "u1" }),
  });
  return registry;
}

describe("PlatformDeliveryRegistry.resolveOperatorDelivery input validation", () => {
  test("resolves a well-formed session URN", () => {
    const delivery = makeRegistry().resolveOperatorDelivery(
      "agent:main:discord:channel:123",
      {} as never,
    );
    expect(delivery).toEqual({ kind: "messaging_surface", userId: "u1" });
  });

  test("throws when sessionId is empty", () => {
    expect(() => makeRegistry().resolveOperatorDelivery("", {} as never)).toThrow(
      "sessionId must be a non-empty string",
    );
  });

  test("throws when sessionId is whitespace-only", () => {
    expect(() => makeRegistry().resolveOperatorDelivery("   ", {} as never)).toThrow(
      "sessionId must be a non-empty string",
    );
  });

  test("returns undefined when the URN has no platform segment", () => {
    const delivery = makeRegistry().resolveOperatorDelivery("agent:main", {} as never);
    expect(delivery).toBeUndefined();
  });

  test("throws when a 3-segment URN has an empty platform segment", () => {
    expect(() => makeRegistry().resolveOperatorDelivery(":::channel:123", {} as never)).toThrow(
      "platform segment must be non-empty",
    );
  });

  test("throws when the platform segment is whitespace-only", () => {
    expect(() =>
      makeRegistry().resolveOperatorDelivery("agent:main: :channel:123", {} as never),
    ).toThrow("platform segment must be non-empty");
  });

  test("returns undefined for an unregistered platform segment", () => {
    const delivery = makeRegistry().resolveOperatorDelivery(
      "agent:main:slack:channel:123",
      {} as never,
    );
    expect(delivery).toBeUndefined();
  });
});
