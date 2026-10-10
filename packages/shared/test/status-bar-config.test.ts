import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { DEFAULT_STATUS_BAR_CONFIG, resolveStatusBarConfig } from "../src/platform-config";
import type { ShoggothConfig } from "../src/schema";
import { statusBarConfigSchema } from "../src/schema";

describe("statusBarConfigSchema", () => {
  it("accepts a full statusBar block", () => {
    const r = statusBarConfigSchema.safeParse({
      enabled: true,
      statusEnabled: true,
      sequenceEnabled: true,
      toolCallsEnabled: true,
      contextWindowEnabled: true,
      compactionsEnabled: true,
    });
    assert.ok(r.success);
  });

  it("accepts an empty block (all fields optional)", () => {
    const r = statusBarConfigSchema.safeParse({});
    assert.ok(r.success);
  });

  it("accepts undefined (schema itself is optional)", () => {
    assert.ok(statusBarConfigSchema.safeParse(undefined).success);
  });

  it("rejects unknown keys (strict)", () => {
    const r = statusBarConfigSchema.safeParse({ bogusOption: true });
    assert.ok(!r.success);
  });

  it("rejects non-boolean values", () => {
    const r = statusBarConfigSchema.safeParse({ enabled: "yes" });
    assert.ok(!r.success);
  });
});

describe("resolveStatusBarConfig", () => {
  afterEach(() => {
    delete process.env.SHOGGOTH_STATUS_BAR;
  });

  function cfgWith(platforms: Record<string, unknown> | undefined): ShoggothConfig {
    return { platforms } as unknown as ShoggothConfig;
  }

  it("returns all-true defaults when platforms.statusBar is absent", () => {
    const r = resolveStatusBarConfig(cfgWith({ discord: { enabled: true } }));
    assert.deepEqual(r, DEFAULT_STATUS_BAR_CONFIG);
    assert.equal(r.enabled, true);
    assert.equal(r.statusEnabled, true);
    assert.equal(r.sequenceEnabled, true);
    assert.equal(r.toolCallsEnabled, true);
    assert.equal(r.contextWindowEnabled, true);
    assert.equal(r.compactionsEnabled, true);
  });

  it("returns all-true defaults when platforms is absent entirely", () => {
    const r = resolveStatusBarConfig(cfgWith(undefined));
    assert.deepEqual(r, DEFAULT_STATUS_BAR_CONFIG);
  });

  it("merges a partial statusBar block over the defaults", () => {
    const r = resolveStatusBarConfig(
      cfgWith({
        statusBar: { contextWindowEnabled: false },
      }),
    );
    assert.deepEqual(r, {
      enabled: true,
      statusEnabled: true,
      sequenceEnabled: true,
      toolCallsEnabled: true,
      contextWindowEnabled: false,
      compactionsEnabled: true,
    });
  });

  it("honors enabled:false from config", () => {
    const r = resolveStatusBarConfig(cfgWith({ statusBar: { enabled: false } }));
    assert.equal(r.enabled, false);
  });

  it("env SHOGGOTH_STATUS_BAR=0 forces enabled:false even when config enables it", () => {
    process.env.SHOGGOTH_STATUS_BAR = "0";
    const r = resolveStatusBarConfig(
      cfgWith({
        statusBar: { enabled: true, statusEnabled: true },
      }),
    );
    assert.equal(r.enabled, false);
  });

  it("env SHOGGOTH_STATUS_BAR=0 forces enabled:false when statusBar is absent", () => {
    process.env.SHOGGOTH_STATUS_BAR = "0";
    const r = resolveStatusBarConfig(cfgWith(undefined));
    assert.equal(r.enabled, false);
  });
});
