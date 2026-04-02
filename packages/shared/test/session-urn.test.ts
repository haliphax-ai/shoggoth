import assert from "node:assert";
import { describe, it } from "vitest";
import {
  defaultPrimarySessionUrnForAgent,
  formatAgentSessionUrn,
  isSubagentSessionUrn,
  isValidAgentSessionUrn,
  mintSubagentSessionUrnFromParent,
  parseAgentSessionUrn,
  resolveAgentWorkspacePath,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
} from "../src/session-urn";

describe("session-urn", () => {
  it("formats and parses top-level URN", () => {
    const u = formatAgentSessionUrn("dev", "discord", "30000000-0000-4000-8000-000000000003");
    assert.ok(isValidAgentSessionUrn(u));
    const p = parseAgentSessionUrn(u);
    assert.deepStrictEqual(p, {
      agentId: "dev",
      platform: "discord",
      uuidChain: ["30000000-0000-4000-8000-000000000003"],
    });
  });

  it("accepts opaque platform-specific tail segments (structure only)", () => {
    const u = "agent:main:slack:my-session-key_01";
    assert.ok(isValidAgentSessionUrn(u));
    const p = parseAgentSessionUrn(u);
    assert.deepStrictEqual(p, {
      agentId: "main",
      platform: "slack",
      uuidChain: ["my-session-key_01"],
    });
  });

  it("accepts numeric channel-style tail without interpreting it (Discord validates elsewhere)", () => {
    const u = "agent:main:discord:1487579255616573533";
    assert.ok(isValidAgentSessionUrn(u));
  });

  it("isSubagentSessionUrn distinguishes depth", () => {
    const top = formatAgentSessionUrn("a", "discord", "40000000-0000-4000-8000-000000000004");
    assert.equal(isSubagentSessionUrn(top), false);
    const sub = mintSubagentSessionUrnFromParent(top, "50000000-0000-4000-8000-000000000005");
    assert.equal(isSubagentSessionUrn(sub), true);
  });

  it("mints subagent with parent leaf uuid", () => {
    const parent = formatAgentSessionUrn("a", "discord", "40000000-0000-4000-8000-000000000004");
    const sub = mintSubagentSessionUrnFromParent(parent, "50000000-0000-4000-8000-000000000005");
    const p = parseAgentSessionUrn(sub);
    assert.strictEqual(p?.uuidChain.length, 2);
    assert.strictEqual(p?.uuidChain[0], "40000000-0000-4000-8000-000000000004");
    assert.strictEqual(p?.uuidChain[1], "50000000-0000-4000-8000-000000000005");
  });

  it("mints subagent with parent leaf opaque id", () => {
    const parent = "agent:main:discord:1487579255616573533";
    const sub = mintSubagentSessionUrnFromParent(parent, "50000000-0000-4000-8000-000000000005");
    const p = parseAgentSessionUrn(sub);
    assert.strictEqual(p?.uuidChain[0], "1487579255616573533");
    assert.strictEqual(p?.uuidChain[1], "50000000-0000-4000-8000-000000000005");
  });

  it("resolveAgentWorkspacePath joins root and agent id", () => {
    const p = resolveAgentWorkspacePath("/var/lib/ws", "main");
    assert.match(p, /[/\\]main$/);
  });

  it("defaultPrimarySessionUrnForAgent uses reserved UUID", () => {
    assert.strictEqual(
      defaultPrimarySessionUrnForAgent("main", "discord"),
      formatAgentSessionUrn("main", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID),
    );
  });
});
