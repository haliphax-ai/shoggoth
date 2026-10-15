import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import { defaultConfig, DEFAULT_TOOL_CALL_TIMEOUT_MS } from "@shoggoth/shared";
import { resolveToolCallTimeoutMs } from "../../src/config/effective-runtime";

const base = defaultConfig("/tmp/cfg");

describe("resolveToolCallTimeoutMs", () => {
  afterEach(() => {
    delete process.env.SHOGGOTH_TOOL_CALL_TIMEOUT_MS;
  });

  it("returns default when nothing is configured", () => {
    assert.equal(
      resolveToolCallTimeoutMs(base, "agent:main:discord:channel:123"),
      DEFAULT_TOOL_CALL_TIMEOUT_MS,
    );
  });

  it("uses runtime.toolCallTimeoutMs when set", () => {
    const cfg = { ...base, runtime: { toolCallTimeoutMs: 30_000 } };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:channel:123"), 30_000);
  });

  it("env SHOGGOTH_TOOL_CALL_TIMEOUT_MS wins over runtime config", () => {
    process.env.SHOGGOTH_TOOL_CALL_TIMEOUT_MS = "5000";
    const cfg = { ...base, runtime: { toolCallTimeoutMs: 30_000 } };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:channel:123"), 5000);
  });

  it("per-agent toolCallTimeoutMs wins over everything", () => {
    process.env.SHOGGOTH_TOOL_CALL_TIMEOUT_MS = "5000";
    const cfg = {
      ...base,
      runtime: { toolCallTimeoutMs: 30_000 },
      agents: { list: { main: { toolCallTimeoutMs: 120_000 } } },
    };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:channel:123"), 120_000);
  });

  it("falls back to global when agent entry has no override", () => {
    const cfg = {
      ...base,
      runtime: { toolCallTimeoutMs: 45_000 },
      agents: { list: { main: { displayName: "Main" } } },
    };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:channel:123"), 45_000);
  });

  it("returns default for unparseable session URN", () => {
    assert.equal(resolveToolCallTimeoutMs(base, "not-a-urn"), DEFAULT_TOOL_CALL_TIMEOUT_MS);
  });

  // max TTL cap (#439): a provided tool-call TTL is never allowed to stretch toward
  // "forever" — it is clamped to runtime.maxTtlMs (default 24h).
  it("caps runtime.toolCallTimeoutMs at runtime.maxTtlMs", () => {
    const cfg = {
      ...base,
      runtime: { toolCallTimeoutMs: 900_000_000, maxTtlMs: 3_600_000 },
    };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:channel:123"), 3_600_000);
  });

  it("caps a per-agent toolCallTimeoutMs at runtime.maxTtlMs", () => {
    const cfg = {
      ...base,
      runtime: { maxTtlMs: 3_600_000 },
      agents: { list: { main: { toolCallTimeoutMs: 900_000_000 } } },
    };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:channel:123"), 3_600_000);
  });

  it("leaves values below the max TTL untouched", () => {
    const cfg = { ...base, runtime: { toolCallTimeoutMs: 30_000, maxTtlMs: 3_600_000 } };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:channel:123"), 30_000);
  });
});
