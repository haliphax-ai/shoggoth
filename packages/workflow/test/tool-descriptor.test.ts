import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildWorkflowToolDescriptor } from "../src/tool-descriptor.js";

describe("buildWorkflowToolDescriptor", () => {
  const descriptor = buildWorkflowToolDescriptor();

  it("returns a descriptor with name workflow", () => {
    assert.equal(descriptor.name, "workflow");
  });

  it("has a non-empty description", () => {
    assert.ok(descriptor.description.length > 0);
  });

  it("has an inputSchema with action property", () => {
    const schema = descriptor.inputSchema as Record<string, unknown>;
    assert.equal(schema.type, "object");
    const props = schema.properties as Record<string, unknown>;
    assert.ok(props.action);
  });

  it("action enum includes all 11 actions", () => {
    const schema = descriptor.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, { enum?: string[] }>;
    const actions = props.action.enum!;
    assert.deepEqual(actions, [
      "start", "abort", "pause", "resume", "status",
      "list", "post", "edit", "retry", "retention", "wait",
    ]);
  });

  it("requires only action", () => {
    const schema = descriptor.inputSchema as Record<string, unknown>;
    assert.deepEqual(schema.required, ["action"]);
  });

  it("includes start-specific fields", () => {
    const schema = descriptor.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    assert.ok(props.tasks);
    assert.ok(props.graph);
    assert.ok(props.name);
    assert.ok(props.reply_to);
    assert.ok(props.polling_interval_ms);
    assert.ok(props.runtime_limit_ms);
  });

  it("includes control plane fields", () => {
    const schema = descriptor.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    assert.ok(props.workflow_id);
    assert.ok(props.task_id);
    assert.ok(props.cascade);
    assert.ok(props.agent_chain_id);
  });
});
