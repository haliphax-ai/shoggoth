import { describe, it } from "node:test";
import assert from "node:assert";
import { buildMessageToolDescriptor } from "../src/message-tool-descriptor";

const fullSlice = {
  attachments: true,
  messageEdit: true,
  messageDelete: true,
  threadCreate: true,
  threadDelete: true,
  replies: true,
  messageGet: true,
} as const;

describe("buildMessageToolDescriptor", () => {
  it("returns undefined when slice is undefined", () => {
    assert.equal(buildMessageToolDescriptor(undefined), undefined);
  });

  it("uses flat input_schema without oneOf (Anthropic-compatible)", () => {
    const d = buildMessageToolDescriptor(fullSlice);
    assert.ok(d);
    assert.equal(d!.name, "message");
    assert.equal(d!.inputSchema.oneOf, undefined);
    assert.equal(d!.inputSchema.type, "object");
    const action = d!.inputSchema.properties?.action;
    assert.ok(action && "enum" in action && Array.isArray(action.enum));
    assert.deepEqual(action.enum, ["post", "get", "edit", "delete", "create_thread", "delete_thread"]);
    assert.deepEqual(d!.inputSchema.required, ["action"]);
    assert.ok(d!.inputSchema.properties?.attachments);
    assert.ok(d!.inputSchema.properties?.reply_to_message_id);
    assert.ok(d!.inputSchema.properties?.channel_id);
    assert.ok(d!.inputSchema.properties?.limit);
    assert.ok(d!.inputSchema.properties?.anchor_message_id);
    assert.ok(d!.inputSchema.properties?.list_direction);
  });

  it("minimal slice: post-only action enum and omits get-only fields when messageGet false", () => {
    const d = buildMessageToolDescriptor({
      attachments: false,
      messageEdit: false,
      messageDelete: false,
      threadCreate: false,
      threadDelete: false,
      replies: false,
      messageGet: false,
    });
    assert.ok(d);
    assert.equal(d!.inputSchema.oneOf, undefined);
    const action = d!.inputSchema.properties?.action;
    assert.deepEqual(action && "enum" in action ? action.enum : null, ["post"]);
    assert.equal(d!.inputSchema.properties?.attachments, undefined);
    assert.equal(d!.inputSchema.properties?.reply_to_message_id, undefined);
    assert.equal(d!.inputSchema.properties?.auto_archive_duration_minutes, undefined);
    assert.equal(d!.inputSchema.properties?.channel_id, undefined);
    assert.equal(d!.inputSchema.properties?.limit, undefined);
  });
});
