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
    assert.equal(resolveToolCallTimeoutMs(base, "agent:main:discord:123"), DEFAULT_TOOL_CALL_TIMEOUT_MS);
  });

  it("uses runtime.toolCallTimeoutMs when set", () => {
    const cfg = { ...base, runtime: { toolCallTimeoutMs: 30_000 } };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:123"), 30_000);
  });

  it("env SHOGGOTH_TOOL_CALL_TIMEOUT_MS wins over runtime config", () => {
    process.env.SHOGGOTH_TOOL_CALL_TIMEOUT_MS = "5000";
    const cfg = { ...base, runtime: { toolCallTimeoutMs: 30_000 } };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:123"), 5000);
  });

  it("per-agent toolCallTimeoutMs wins over everything", () => {
    process.env.SHOGGOTH_TOOL_CALL_TIMEOUT_MS = "5000";
    const cfg = {
      ...base,
      runtime: { toolCallTimeoutMs: 30_000 },
      agents: { list: { main: { toolCallTimeoutMs: 120_000 } } },
    };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:123"), 120_000);
  });

  it("falls back to global when agent entry has no override", () => {
    const cfg = {
      ...base,
      runtime: { toolCallTimeoutMs: 45_000 },
      agents: { list: { main: { displayName: "Main" } } },
    };
    assert.equal(resolveToolCallTimeoutMs(cfg, "agent:main:discord:123"), 45_000);
  });

  it("returns default for unparseable session URN", () => {
    assert.equal(resolveToolCallTimeoutMs(base, "not-a-urn"), DEFAULT_TOOL_CALL_TIMEOUT_MS);
  });
});
