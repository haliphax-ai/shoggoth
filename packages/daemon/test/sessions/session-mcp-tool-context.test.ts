import assert from "node:assert";
import { describe, it } from "vitest";
import { formatAgentSessionUrn, mintSubagentSessionUrnFromParent } from "@shoggoth/shared";
import {
  buildBuiltinOnlySessionMcpToolContext,
  omitBuiltinSubagentToolForSubagentSession,
} from "../../src/sessions/session-mcp-tool-context";

describe("session-mcp-tool-context", () => {
  it("strips builtin.subagent for subagent session URNs only", () => {
    const base = buildBuiltinOnlySessionMcpToolContext();
    const top = formatAgentSessionUrn("main", "discord", "channel", "40000000-0000-4000-8000-000000000099");
    const sub = mintSubagentSessionUrnFromParent(top, "50000000-0000-4000-8000-000000000088");

    const topCtx = omitBuiltinSubagentToolForSubagentSession(base, top);
    assert.ok(topCtx.aggregated.tools.some((t) => t.originalName === "subagent"));

    const subCtx = omitBuiltinSubagentToolForSubagentSession(base, sub);
    assert.ok(!subCtx.aggregated.tools.some((t) => t.originalName === "subagent"));
    assert.equal(subCtx.aggregated.tools.length, base.aggregated.tools.length - 1);
  });
});
