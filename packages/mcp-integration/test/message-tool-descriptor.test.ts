import { describe, it } from "vitest";
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
  react: true,
  reactions: true,
  search: true,
  attachmentDownload: true,
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
    assert.deepEqual(action.enum, [
      "post", "get", "edit", "delete", "create_thread", "delete_thread",
      "react", "reactions", "search", "attachment-download",
    ]);
    assert.deepEqual(d!.inputSchema.required, ["action"]);
    assert.ok(d!.inputSchema.properties?.attachments);
    assert.ok(d!.inputSchema.properties?.reply_to_message_id);
    assert.ok(d!.inputSchema.properties?.channel_id);
    assert.ok(d!.inputSchema.properties?.limit);
    assert.ok(d!.inputSchema.properties?.anchor_message_id);
    assert.ok(d!.inputSchema.properties?.list_direction);
    // New capability fields
    assert.ok(d!.inputSchema.properties?.emoji);
    assert.ok(d!.inputSchema.properties?.remove);
    assert.ok(d!.inputSchema.properties?.query);
    assert.ok(d!.inputSchema.properties?.author_id);
    assert.ok(d!.inputSchema.properties?.author_ids);
    assert.ok(d!.inputSchema.properties?.before);
    assert.ok(d!.inputSchema.properties?.after);
    assert.ok(d!.inputSchema.properties?.from_me);
    assert.ok(d!.inputSchema.properties?.channel_ids);
    assert.ok(d!.inputSchema.properties?.filename);
    assert.ok(d!.inputSchema.properties?.index);
    assert.ok(d!.inputSchema.properties?.path);
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
      react: false,
      reactions: false,
      search: false,
      attachmentDownload: false,
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
    // New capability fields should also be absent
    assert.equal(d!.inputSchema.properties?.emoji, undefined);
    assert.equal(d!.inputSchema.properties?.remove, undefined);
    assert.equal(d!.inputSchema.properties?.query, undefined);
    assert.equal(d!.inputSchema.properties?.author_id, undefined);
    assert.equal(d!.inputSchema.properties?.filename, undefined);
    assert.equal(d!.inputSchema.properties?.index, undefined);
    assert.equal(d!.inputSchema.properties?.path, undefined);
  });

  it("react-only slice includes emoji and remove but not search/attachment fields", () => {
    const d = buildMessageToolDescriptor({
      attachments: false,
      messageEdit: false,
      messageDelete: false,
      threadCreate: false,
      threadDelete: false,
      replies: false,
      messageGet: false,
      react: true,
      reactions: false,
      search: false,
      attachmentDownload: false,
    });
    assert.ok(d);
    const action = d!.inputSchema.properties?.action;
    assert.ok(action && "enum" in action && Array.isArray(action.enum));
    assert.ok(action.enum.includes("react"));
    assert.ok(!action.enum.includes("reactions"));
    assert.ok(d!.inputSchema.properties?.emoji);
    assert.ok(d!.inputSchema.properties?.remove);
    assert.equal(d!.inputSchema.properties?.query, undefined);
    assert.equal(d!.inputSchema.properties?.filename, undefined);
  });

  it("search-only slice includes search params and limit", () => {
    const d = buildMessageToolDescriptor({
      attachments: false,
      messageEdit: false,
      messageDelete: false,
      threadCreate: false,
      threadDelete: false,
      replies: false,
      messageGet: false,
      react: false,
      reactions: false,
      search: true,
      attachmentDownload: false,
    });
    assert.ok(d);
    const action = d!.inputSchema.properties?.action;
    assert.ok(action && "enum" in action && Array.isArray(action.enum));
    assert.ok(action.enum.includes("search"));
    assert.ok(d!.inputSchema.properties?.query);
    assert.ok(d!.inputSchema.properties?.author_id);
    assert.ok(d!.inputSchema.properties?.author_ids);
    assert.ok(d!.inputSchema.properties?.before);
    assert.ok(d!.inputSchema.properties?.after);
    assert.ok(d!.inputSchema.properties?.from_me);
    assert.ok(d!.inputSchema.properties?.channel_ids);
    assert.ok(d!.inputSchema.properties?.limit);
  });

  it("attachment-download slice includes filename, index, path", () => {
    const d = buildMessageToolDescriptor({
      attachments: false,
      messageEdit: false,
      messageDelete: false,
      threadCreate: false,
      threadDelete: false,
      replies: false,
      messageGet: false,
      react: false,
      reactions: false,
      search: false,
      attachmentDownload: true,
    });
    assert.ok(d);
    const action = d!.inputSchema.properties?.action;
    assert.ok(action && "enum" in action && Array.isArray(action.enum));
    assert.ok(action.enum.includes("attachment-download"));
    assert.ok(d!.inputSchema.properties?.filename);
    assert.ok(d!.inputSchema.properties?.index);
    assert.ok(d!.inputSchema.properties?.path);
  });
});
