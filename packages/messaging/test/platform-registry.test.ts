import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPlatform,
  getPlatformRegistration,
  clearPlatformRegistry,
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
    expect(() => registerPlatform(makeReg({ platformId: "discord" }))).toThrow(/already registered/i);
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
      registerPlatform({ platformId: "x", resourceTypes: ["ch"], urnPolicy: undefined as any }),
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
});
