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
