import { describe, it } from "vitest";
import assert from "node:assert";
import { builtinShoggothToolsCatalog } from "../src/builtin-shoggoth-tools";

function execTool() {
  const catalog = builtinShoggothToolsCatalog();
  const exec = catalog.tools.find((t) => t.name === "exec");
  assert.ok(exec, "exec tool should exist");
  return exec;
}

describe("exec tool descriptor", () => {
  it("includes the optional notify flag (default true) for background completion notifications", () => {
    const notify = execTool().inputSchema.properties?.notify;
    assert.ok(notify, "notify property should exist so background callers can opt out");
    assert.equal(notify.type, "boolean", "notify should be of type boolean");
    assert.ok(
      typeof notify.description === "string" && notify.description.includes("Default: true"),
      "notify description should state the default is true",
    );
    assert.ok(!execTool().inputSchema.required?.includes("notify"), "notify must stay optional");
  });

  it("yieldMs description documents the 30 s cap and that values are clamped, not ignored", () => {
    const yieldMs = execTool().inputSchema.properties?.yieldMs;
    assert.ok(yieldMs, "yieldMs property should exist");
    const description = String(yieldMs.description);
    assert.ok(description.includes("30000"), "yieldMs description should mention the 30 s cap");
    assert.ok(
      description.toLowerCase().includes("clamp"),
      "yieldMs description should say values are clamped",
    );
  });

  it("keeps yieldMs optional with a non-negative minimum", () => {
    const yieldMs = execTool().inputSchema.properties?.yieldMs;
    assert.ok(yieldMs);
    assert.equal(yieldMs.minimum, 0);
    assert.ok(!execTool().inputSchema.required?.includes("yieldMs"));
  });
});
