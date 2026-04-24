import { describe, it } from "vitest";
import assert from "node:assert";
import {
  executeMessageToolAction,
  type MessageToolTransport,
  summarizeApiMessage,
} from "@shoggoth/messaging";
import type { MessagingAdapterCapabilities } from "@shoggoth/messaging";

/** Minimal capability descriptor with all extensions enabled (mirrors Discord's shape). */
function allCaps(): MessagingAdapterCapabilities {
  return {
    platform: "test",
    supports: { markdown: true, directMessages: true, groupChannels: true },
    extensions: {
      attachments: true,
      threads: true,
      replies: true,
      reactionsInbound: true,
      streamingOutbound: true,
      messageEdit: true,
      messageDelete: true,
      threadCreate: true,
      threadDelete: true,
      messageGet: true,
      react: true,
      reactions: true,
      search: true,
      attachmentDownload: true,
    },
    parameterSchemas: {
      outboundText: { type: "object" },
      attachment: { type: "object" },
      threadReply: { type: "object" },
      streamChunk: { type: "object" },
    },
  };
}

function mockTransport(overrides?: Partial<MessageToolTransport>): MessageToolTransport {
  return {
    async createMessage() {
      return { id: "x" };
    },
    async createMessageWithFiles() {
      return { id: "x" };
    },
    async editMessage() {},
    async deleteMessage() {},
    async getMessage(channelId, messageId) {
      return {
        id: messageId,
        channel_id: channelId,
        content: "body",
        timestamp: "2026-01-01T00:00:00.000Z",
        author: { id: "u1", username: "tester", bot: false },
        attachments: [],
      };
    },
    async getChannelMessages() {
      return [];
    },
    async createThreadFromMessage() {
      return { id: "t" };
    },
    async deleteChannel() {},
    async createMessageReaction() {},
    async deleteMessageReaction() {},
    async getMessageReactions() {
      return [];
    },
    async searchMessages() {
      return { messages: [], total_results: 0 };
    },
    ...overrides,
  };
}

describe("executeMessageToolAction", () => {
  const caps = allCaps();

  // --- post ---
  it("post: JSON createMessage when no attachments", async () => {
    const calls: string[] = [];
    const transport = mockTransport({
      async createMessage(ch, body) {
        calls.push(`create:${ch}:${body.content}`);
        return { id: "m1" };
      },
      async createMessageWithFiles() {
        throw new Error("unexpected multipart");
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "chan-a" },
      "agent:x:discord:channel:00000000-0000-4000-8000-000000000001",
      { action: "post", content: "hello" },
    );
    assert.deepEqual(r, { ok: true, message_id: "m1", channel_id: "chan-a" });
    assert.equal(calls[0], "create:chan-a:hello");
  });

  it("post: multipart when attachments present", async () => {
    let multipart = false;
    const transport = mockTransport({
      async createMessage() {
        throw new Error("unexpected json");
      },
      async createMessageWithFiles(ch, body) {
        multipart = true;
        assert.equal(ch, "chan-b");
        assert.equal(body.content, "f");
        return { id: "m2" };
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "chan-b" },
      "sess",
      {
        action: "post",
        content: "f",
        attachments: [{ filename: "x.bin", content_base64: "YWI=" }],
      },
    );
    assert.deepEqual(r, { ok: true, message_id: "m2", channel_id: "chan-b" });
    assert.equal(multipart, true);
  });

  it("post: content_path reads file from workspace", async () => {
    let capturedPath: string | undefined;
    const transport = mockTransport({
      async createMessageWithFiles(_ch, _body, files) {
        capturedPath = Buffer.from(files[0]?.data ?? new Uint8Array()).toString();
        return { id: "m3" };
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "chan-c",
        readWorkspaceFile: async (_sid, path) => {
          return Buffer.from(`file content from ${path}`);
        },
      },
      "sess",
      {
        action: "post",
        content: "with file",
        attachments: [{ filename: "readme.txt", content_path: "docs/readme.txt" }],
      },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.equal(capturedPath, "file content from docs/readme.txt");
  });

  it("post: content_path enforces 24MB size limit", async () => {
    const transport = mockTransport({
      async createMessageWithFiles() {
        throw new Error("should not be called");
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "chan-c",
        readWorkspaceFile: async () => {
          // Create a buffer larger than 24MB
          return Buffer.alloc(25 * 1024 * 1024);
        },
      },
      "sess",
      {
        action: "post",
        attachments: [{ filename: "big.bin", content_path: "big.bin" }],
      },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("exceeds size limit"));
  });

  it("post: error when both content_base64 and content_path provided", async () => {
    const transport = mockTransport();
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "chan-c",
        readWorkspaceFile: async () => Buffer.from("x"),
      },
      "sess",
      {
        action: "post",
        attachments: [{ filename: "f.txt", content_base64: "YWI=", content_path: "f.txt" }],
      },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("mutually exclusive"));
  });

  it("post: error when neither content_base64 nor content_path provided", async () => {
    const transport = mockTransport();
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "chan-c",
      },
      "sess",
      {
        action: "post",
        attachments: [{ filename: "f.txt" }],
      },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("either content_base64 or content_path"));
  });

  it("post: error when content_path used but readWorkspaceFile not wired", async () => {
    const transport = mockTransport();
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "chan-c",
        // readWorkspaceFile not provided
      },
      "sess",
      {
        action: "post",
        attachments: [{ filename: "f.txt", content_path: "f.txt" }],
      },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("readWorkspaceFile handler"));
  });

  it("rejects attachments when capability off", async () => {
    const transport = mockTransport();
    const noAtt = {
      ...caps,
      extensions: { ...caps.extensions, attachments: false },
    };
    const r = await executeMessageToolAction(
      { capabilities: noAtt, transport, sessionToChannel: () => "c" },
      "sess",
      {
        action: "post",
        content: "a",
        attachments: [{ filename: "f", content_base64: "QQ==" }],
      },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  it("returns error when session has no channel mapping (generic error key)", async () => {
    const transport = mockTransport();
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => undefined },
      "sess",
      { action: "post", content: "a" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.equal((r as { error: string }).error, "no_channel_for_session");
  });

  // --- get ---
  it("get: single message by message_id", async () => {
    const transport = mockTransport({
      async getMessage(ch, mid) {
        return {
          id: mid,
          channel_id: ch,
          content: "hello",
          timestamp: "t",
          author: { id: "a", username: "u", bot: false },
          attachments: [{ filename: "f.png" }],
        };
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "chan-z" },
      "sess",
      { action: "get", message_id: "snow1" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    const msgs = (r as { messages: { content: string; attachment_count: number }[] }).messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.content, "hello");
    assert.equal(msgs[0]!.attachment_count, 1);
  });

  it("get: latest messages uses bound channel and limit", async () => {
    let lastQuery: { limit?: number } | undefined;
    const transport = mockTransport({
      async getChannelMessages(ch, q) {
        assert.equal(ch, "c99");
        lastQuery = q;
        return [
          {
            id: "m1",
            channel_id: ch,
            content: "a",
            timestamp: "t",
            author: { id: "1", username: "x" },
            attachments: [],
          },
        ];
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "c99" },
      "sess",
      { action: "get", limit: 5 },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.deepEqual(lastQuery, { limit: 5 });
    assert.equal((r as { messages: unknown[] }).messages.length, 1);
  });

  it("get: anchor + list_direction passes cursor", async () => {
    let lastQuery: unknown;
    const transport = mockTransport({
      async getChannelMessages(_ch, q) {
        lastQuery = q;
        return [];
      },
    });
    await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "c" },
      "sess",
      {
        action: "get",
        anchor_message_id: "anchor1",
        list_direction: "before",
        limit: 3,
      },
    );
    assert.deepEqual(lastQuery, { limit: 3, before: "anchor1" });
  });

  it("get: channel_id without session binding", async () => {
    const transport = mockTransport({
      async getMessage(ch) {
        assert.equal(ch, "explicit-ch");
        return {
          id: "mid",
          channel_id: ch,
          content: "x",
          timestamp: "t",
          author: {},
          attachments: [],
        };
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => undefined },
      "sess",
      { action: "get", channel_id: "explicit-ch", message_id: "mid" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
  });

  it("get rejected when messageGet capability off", async () => {
    const transport = mockTransport();
    const noGet = {
      ...caps,
      extensions: { ...caps.extensions, messageGet: false },
    };
    const r = await executeMessageToolAction(
      { capabilities: noGet, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "get", message_id: "x" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  // --- react ---
  it("react: adds a reaction", async () => {
    let reacted: { ch: string; mid: string; emoji: string } | undefined;
    const transport = mockTransport({
      async createMessageReaction(ch, mid, emoji) {
        reacted = { ch, mid, emoji };
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "react", message_id: "m1", emoji: "✅" },
    );
    assert.deepEqual(r, {
      ok: true,
      message_id: "m1",
      channel_id: "ch1",
      emoji: "✅",
      removed: false,
    });
    assert.deepEqual(reacted, { ch: "ch1", mid: "m1", emoji: "✅" });
  });

  it("react: removes a reaction when remove=true", async () => {
    let removed = false;
    const transport = mockTransport({
      async deleteMessageReaction() {
        removed = true;
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "react", message_id: "m1", emoji: "👀", remove: true },
    );
    assert.deepEqual(r, {
      ok: true,
      message_id: "m1",
      channel_id: "ch1",
      emoji: "👀",
      removed: true,
    });
    assert.equal(removed, true);
  });

  it("react: rejected when capability off", async () => {
    const transport = mockTransport();
    const noReact = {
      ...caps,
      extensions: { ...caps.extensions, react: false },
    };
    const r = await executeMessageToolAction(
      { capabilities: noReact, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "react", message_id: "m1", emoji: "✅" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  it("react: requires emoji parameter", async () => {
    const transport = mockTransport();
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "react", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  // --- reactions ---
  it("reactions: returns users for a specific emoji", async () => {
    const transport = mockTransport({
      async getMessageReactions() {
        return [
          { id: "u1", username: "alice", bot: false },
          { id: "u2", username: "bob", bot: true },
        ];
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "reactions", message_id: "m1", emoji: "✅" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    const reactions = (r as { reactions: { emoji: string; count: number; users: unknown[] }[] })
      .reactions;
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0]!.emoji, "✅");
    assert.equal(reactions[0]!.count, 2);
  });

  it("reactions: returns all reactions summary when no emoji filter", async () => {
    const transport = mockTransport({
      async getMessage() {
        return {
          id: "m1",
          channel_id: "ch1",
          content: "test",
          timestamp: "t",
          author: { id: "a", username: "u" },
          attachments: [],
          reactions: [
            { emoji: { name: "✅", id: null }, count: 3, me: true },
            { emoji: { name: "fire", id: "12345" }, count: 1, me: false },
          ],
        };
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "reactions", message_id: "m1" },
    );
    const reactions = (r as { reactions: { emoji: string; count: number; me: boolean }[] })
      .reactions;
    assert.equal(reactions.length, 2);
    assert.equal(reactions[0]!.emoji, "✅");
    assert.equal(reactions[1]!.emoji, "fire:12345");
  });

  it("reactions: rejected when capability off", async () => {
    const transport = mockTransport();
    const noReactions = {
      ...caps,
      extensions: { ...caps.extensions, reactions: false },
    };
    const r = await executeMessageToolAction(
      { capabilities: noReactions, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "reactions", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  // --- search ---
  it("search: passes query and filters to transport", async () => {
    let capturedQuery: unknown;
    const transport = mockTransport({
      async searchMessages(_guildId, query) {
        capturedQuery = query;
        return {
          total_results: 1,
          messages: [
            [
              {
                id: "m1",
                channel_id: "ch1",
                content: "rollback deploy",
                timestamp: "2026-03-30T12:00:00Z",
                author: { id: "u1", username: "haliphax", bot: false },
                attachments: [],
              },
            ],
          ],
        };
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        sessionToGuild: () => "guild1",
      },
      "sess",
      {
        action: "search",
        query: "rollback",
        author_id: "u1",
        after: "2026-03-30T00:00:00Z",
        limit: 10,
      },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.equal((r as { total_results: number }).total_results, 1);
    const q = capturedQuery as {
      content: string;
      author_id: string;
      min_id: string;
      limit: number;
    };
    assert.equal(q.content, "rollback");
    assert.equal(q.author_id, "u1");
    assert.equal(q.limit, 10);
  });

  it("search: returns error when no guild context", async () => {
    const transport = mockTransport();
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "search", query: "test" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("guild"));
  });

  it("search: rejected when capability off", async () => {
    const transport = mockTransport();
    const noSearch = {
      ...caps,
      extensions: { ...caps.extensions, search: false },
    };
    const r = await executeMessageToolAction(
      {
        capabilities: noSearch,
        transport,
        sessionToChannel: () => "ch1",
        sessionToGuild: () => "guild1",
      },
      "sess",
      { action: "search", query: "test" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  it("search: defaults channel_ids to bound channel", async () => {
    let capturedQuery: unknown;
    const transport = mockTransport({
      async searchMessages(_guildId, query) {
        capturedQuery = query;
        return { total_results: 0, messages: [] };
      },
    });
    await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "bound-ch",
        sessionToGuild: () => "g1",
      },
      "sess",
      { action: "search", query: "hello" },
    );
    assert.equal((capturedQuery as { channel_id: string }).channel_id, "bound-ch");
  });

  // --- attachment-download ---
  it("attachment-download: downloads first attachment by default", async () => {
    let downloadedUrl: string | undefined;
    const transport = mockTransport({
      async getMessage() {
        return {
          id: "m1",
          channel_id: "ch1",
          content: "here's the log",
          timestamp: "t",
          author: { id: "u1", username: "tester" },
          attachments: [
            {
              id: "att1",
              filename: "error.log",
              url: "https://cdn.example.com/att1/error.log",
              content_type: "text/plain",
              size: 4096,
            },
          ],
        };
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        downloadFile: async (url, _path) => {
          downloadedUrl = url;
          return 4096;
        },
      },
      "sess",
      { action: "attachment-download", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.equal((r as { filename: string }).filename, "error.log");
    assert.equal((r as { size: number }).size, 4096);
    assert.equal(downloadedUrl, "https://cdn.example.com/att1/error.log");
  });

  it("attachment-download: selects by filename", async () => {
    const transport = mockTransport({
      async getMessage() {
        return {
          id: "m1",
          channel_id: "ch1",
          content: "",
          timestamp: "t",
          author: {},
          attachments: [
            {
              id: "a1",
              filename: "first.txt",
              url: "https://cdn/first.txt",
              size: 100,
            },
            {
              id: "a2",
              filename: "second.csv",
              url: "https://cdn/second.csv",
              content_type: "text/csv",
              size: 200,
            },
          ],
        };
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        downloadFile: async () => 200,
      },
      "sess",
      {
        action: "attachment-download",
        message_id: "m1",
        filename: "second.csv",
      },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.equal((r as { filename: string }).filename, "second.csv");
    assert.equal((r as { mimeType: string }).mimeType, "text/csv");
  });

  it("attachment-download: returns error for missing filename", async () => {
    const transport = mockTransport({
      async getMessage() {
        return {
          id: "m1",
          channel_id: "ch1",
          content: "",
          timestamp: "t",
          author: {},
          attachments: [
            {
              id: "a1",
              filename: "only.txt",
              url: "https://cdn/only.txt",
              size: 10,
            },
          ],
        };
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        downloadFile: async () => 0,
      },
      "sess",
      { action: "attachment-download", message_id: "m1", filename: "nope.txt" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("nope.txt"));
  });

  it("attachment-download: returns error when no attachments", async () => {
    const transport = mockTransport({
      async getMessage() {
        return {
          id: "m1",
          channel_id: "ch1",
          content: "no files",
          timestamp: "t",
          author: {},
          attachments: [],
        };
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        downloadFile: async () => 0,
      },
      "sess",
      { action: "attachment-download", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("no attachments"));
  });

  it("attachment-download: rejects oversized attachments", async () => {
    const transport = mockTransport({
      async getMessage() {
        return {
          id: "m1",
          channel_id: "ch1",
          content: "",
          timestamp: "t",
          author: {},
          attachments: [
            {
              id: "a1",
              filename: "huge.bin",
              url: "https://cdn/huge.bin",
              size: 30 * 1024 * 1024,
            },
          ],
        };
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        downloadFile: async () => 0,
      },
      "sess",
      { action: "attachment-download", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("too large"));
  });

  it("attachment-download: rejected when capability off", async () => {
    const transport = mockTransport();
    const noDownload = {
      ...caps,
      extensions: { ...caps.extensions, attachmentDownload: false },
    };
    const r = await executeMessageToolAction(
      { capabilities: noDownload, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "attachment-download", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  it("attachment-download: returns error when downloadFile not configured", async () => {
    const transport = mockTransport({
      async getMessage() {
        return {
          id: "m1",
          channel_id: "ch1",
          content: "",
          timestamp: "t",
          author: {},
          attachments: [{ id: "a1", filename: "f.txt", url: "https://cdn/f.txt", size: 10 }],
        };
      },
    });
    const r = await executeMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "attachment-download", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("downloadFile"));
  });

  it("attachment-download: sanitizes path traversal in filenames", async () => {
    let savedPath: string | undefined;
    const transport = mockTransport({
      async getMessage() {
        return {
          id: "m1",
          channel_id: "ch1",
          content: "",
          timestamp: "t",
          author: {},
          attachments: [
            {
              id: "a1",
              filename: "../../etc/passwd",
              url: "https://cdn/x",
              size: 10,
            },
          ],
        };
      },
    });
    const r = await executeMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        downloadFile: async (_url, path) => {
          savedPath = path;
          return 10;
        },
      },
      "sess",
      { action: "attachment-download", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    const filename = (r as { filename: string }).filename;
    assert.ok(!filename.includes(".."));
    assert.ok(!filename.includes("/"));
    assert.ok(savedPath);
    assert.ok(!savedPath!.includes(".."));
  });

  // --- summarizeApiMessage ---
  it("summarizeApiMessage extracts expected fields", () => {
    const raw = {
      id: "m1",
      channel_id: "ch1",
      content: "hello",
      timestamp: "t",
      author: { id: "a1", username: "bob", bot: true },
      attachments: [{ filename: "f.png" }, { filename: "g.txt" }],
    };
    const s = summarizeApiMessage(raw);
    assert.equal(s.id, "m1");
    assert.equal(s.content, "hello");
    assert.equal(s.author_id, "a1");
    assert.equal(s.author_username, "bob");
    assert.equal(s.bot, true);
    assert.equal(s.attachment_count, 2);
    assert.deepEqual(s.attachment_filenames, ["f.png", "g.txt"]);
  });
});
