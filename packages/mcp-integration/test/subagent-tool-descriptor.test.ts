import { describe, it } from "vitest";
import assert from "node:assert";
import { builtinShoggothToolsCatalog } from "../src/builtin-shoggoth-tools";

describe("subagent tool descriptor", () => {
  it("includes thread_name property with type string", () => {
    const catalog = builtinShoggothToolsCatalog();
    const subagentTool = catalog.tools.find((t) => t.name === "subagent");
    assert.ok(subagentTool, "subagent tool should exist");

    const threadName = subagentTool.inputSchema.properties?.thread_name;
    assert.ok(threadName, "thread_name property should exist");
    assert.equal(threadName.type, "string", "thread_name should be of type string");
  });

  it("includes optional agent_id property with type string", () => {
    const catalog = builtinShoggothToolsCatalog();
    const subagentTool = catalog.tools.find((t) => t.name === "subagent");
    assert.ok(subagentTool, "subagent tool should exist");

    const agentId = subagentTool.inputSchema.properties?.agent_id;
    assert.ok(agentId, "agent_id property should exist so spawn callers can supply it");
    assert.equal(agentId.type, "string", "agent_id should be of type string");
    assert.ok(
      typeof agentId.description === "string" && agentId.description.includes("derived"),
      "agent_id description should mention automatic derivation when omitted",
    );
    assert.ok(
      !subagentTool.inputSchema.required?.includes("agent_id"),
      "agent_id must stay optional (derived by the handler when omitted)",
    );
  });

  it("thread_id description mentions '0' for creating a new thread", () => {
    const catalog = builtinShoggothToolsCatalog();
    const subagentTool = catalog.tools.find((t) => t.name === "subagent");
    assert.ok(subagentTool, "subagent tool should exist");

    const threadId = subagentTool.inputSchema.properties?.thread_id;
    assert.ok(threadId, "thread_id property should exist");
    assert.ok(
      typeof threadId.description === "string" && threadId.description.includes('"0"'),
      "thread_id description should mention '0' for creating a new thread",
    );
  });
});
