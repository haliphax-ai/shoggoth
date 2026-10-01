import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPlatform,
  getPlatformRegistration,
  unregisterPlatform,
  clearPlatformRegistry,
  PlatformRegistry,
  type PlatformRegistration,
} from "../src/platform-registry";

/** Minimal valid registration for tests. */
function makeReg(overrides?: Partial<PlatformRegistration>): PlatformRegistration {
  return {
    platformId: "test-platform",
    resourceTypes: ["channel"],
    urnPolicy: {
      platformId: "test-platform",
      checkRouteSessionUrn: () => "ok",
      assertRoutesDefaultPrimaryUuidMatchesAgent: () => {},
      parseFirstChannelIdFromRoutesJson: () => undefined,
      resolveBootstrapPrimarySessionUrn: (a, p) => `agent:${a}:${p}:default`,
    },
    ...overrides,
  };
}

describe("Platform Registry", () => {
  beforeEach(() => {
    clearPlatformRegistry();
  });

  // ---- registerPlatform + getPlatformRegistration ----

  it("stores a registration and retrieves it by platformId", () => {
    const reg = makeReg();
    registerPlatform(reg);
    expect(getPlatformRegistration("test-platform")).toBe(reg);
  });

  it("retrieves registration case-insensitively", () => {
    const reg = makeReg();
    registerPlatform(reg);
    expect(getPlatformRegistration("TEST-PLATFORM")).toBe(reg);
    expect(getPlatformRegistration("Test-Platform")).toBe(reg);
  });

  // ---- unknown platform ----

  it("returns undefined for an unknown platformId", () => {
    expect(getPlatformRegistration("nonexistent")).toBeUndefined();
  });

  // ---- duplicate registration ----

  it("throws on duplicate registration for the same platformId", () => {
    registerPlatform(makeReg());
    expect(() => registerPlatform(makeReg())).toThrow(/already registered/i);
  });

  it("throws on duplicate registration regardless of case", () => {
    registerPlatform(makeReg({ platformId: "Discord" }));
    expect(() => registerPlatform(makeReg({ platformId: "discord" }))).toThrow(
      /already registered/i,
    );
  });

  // ---- shape validation ----

  it("throws when platformId is empty", () => {
    expect(() => registerPlatform(makeReg({ platformId: "" }))).toThrow(/platformId/i);
  });

  it("throws when platformId is whitespace-only", () => {
    expect(() => registerPlatform(makeReg({ platformId: "   " }))).toThrow(/platformId/i);
  });

  it("throws when resourceTypes is empty", () => {
    expect(() => registerPlatform(makeReg({ resourceTypes: [] }))).toThrow(/resourceTypes/i);
  });

  it("throws when urnPolicy is missing", () => {
    expect(() =>
      registerPlatform({
        platformId: "x",
        resourceTypes: ["ch"],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        urnPolicy: undefined as any,
      }),
    ).toThrow(/urnPolicy/i);
  });

  // ---- optional validators ----

  it("accepts registration without validateConfig or validateUrn", () => {
    const reg = makeReg({ validateConfig: undefined, validateUrn: undefined });
    registerPlatform(reg);
    expect(getPlatformRegistration("test-platform")).toBe(reg);
  });

  it("stores validateConfig and validateUrn when provided", () => {
    const validateConfig = () => null;
    const validateUrn = () => null;
    const reg = makeReg({ validateConfig, validateUrn });
    registerPlatform(reg);
    const stored = getPlatformRegistration("test-platform")!;
    expect(stored.validateConfig).toBe(validateConfig);
    expect(stored.validateUrn).toBe(validateUrn);
  });

  // ---- unregisterPlatform ----

  it("removes a registration via unregisterPlatform", () => {
    registerPlatform(makeReg());
    expect(unregisterPlatform("test-platform")).toBe(true);
    expect(getPlatformRegistration("test-platform")).toBeUndefined();
  });

  it("unregisterPlatform is case-insensitive and false for unknown ids", () => {
    registerPlatform(makeReg());
    expect(unregisterPlatform("  TEST-PLATFORM  ")).toBe(true);
    expect(unregisterPlatform("test-platform")).toBe(false);
  });
});

describe("PlatformRegistry instances", () => {
  it("instances are isolated from the process-wide registry", () => {
    const a = new PlatformRegistry();
    const b = new PlatformRegistry();
    a.register(makeReg());
    expect(a.get("test-platform")).toBeDefined();
    expect(b.get("test-platform")).toBeUndefined();
    expect(getPlatformRegistration("test-platform")).toBeUndefined();
  });

  it("supports register/unregister/clear on an isolated instance", () => {
    const reg = new PlatformRegistry();
    reg.register(makeReg());
    expect(reg.unregister("test-platform")).toBe(true);
    reg.register(makeReg());
    reg.clear();
    expect(reg.get("test-platform")).toBeUndefined();
  });
});
