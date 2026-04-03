import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveSessionBypassUpTo } from "../../src/hitl/session-agent-principals.js";
import { defaultConfig } from "@shoggoth/shared";

const baseConfig = defaultConfig("/tmp/test-config");

describe("resolveSessionBypassUpTo", () => {
  it("returns root hitl.bypassUpTo when no per-agent override exists", () => {
    assert.equal(
      resolveSessionBypassUpTo("agent:main:discord:channel:00000000-0000-4000-8000-000000000001", baseConfig),
      "safe",
    );
  });

  it("returns per-agent hitl.bypassUpTo when set", () => {
    const config = {
      ...baseConfig,
      agents: { list: { main: { hitl: { bypassUpTo: "critical" as const } } } },
    };
    assert.equal(
      resolveSessionBypassUpTo("agent:main:discord:channel:00000000-0000-4000-8000-000000000001", config),
      "critical",
    );
  });

  it("falls back to root default for unknown agent", () => {
    const config = {
      ...baseConfig,
      agents: { list: { other: { hitl: { bypassUpTo: "critical" as const } } } },
    };
    assert.equal(
      resolveSessionBypassUpTo("agent:main:discord:channel:00000000-0000-4000-8000-000000000001", config),
      "safe",
    );
  });

  it("falls back to root default for non-URN session id", () => {
    assert.equal(resolveSessionBypassUpTo("not-a-urn", baseConfig), "safe");
  });

  it("uses same agent id for subagent URNs", () => {
    const config = {
      ...baseConfig,
      agents: { list: { pytest: { hitl: { bypassUpTo: "caution" as const } } } },
    };
    assert.equal(
      resolveSessionBypassUpTo(
        "agent:pytest:discord:channel:10000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000002",
        config,
      ),
      "caution",
    );
  });
});
