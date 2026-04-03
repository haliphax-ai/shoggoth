import { describe, it } from "vitest";
import assert from "node:assert";
import { discordCapabilityDescriptor } from "../src/capabilities";
import { executeDiscordMessageToolAction } from "../src/message-tool";
import type { DiscordRestTransport } from "../src/transport";

function emptyGetStubs(): Pick<
  DiscordRestTransport,
  "getMessage" | "getChannelMessages"
> {
  return {
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
  };
}

/** Builds a full mock transport with sensible defaults for all methods. */
function mockTransport(
  overrides?: Partial<DiscordRestTransport>,
): DiscordRestTransport {
  return {
    async openDmChannel() { return "dm"; },
    async createMessage() { return { id: "x" }; },
    async createMessageWithFiles() { return { id: "x" }; },
    async editMessage() {},
    async deleteMessage() {},
    ...emptyGetStubs(),
    async createThreadFromMessage() { return { id: "t" }; },
    async deleteChannel() {},
    async createMessageReaction() {},
    async deleteMessageReaction() {},
    async getMessageReactions() { return []; },
    async searchMessages() { return { messages: [], total_results: 0 }; },
    async triggerTypingIndicator() {},
    async interactionCallback() {},
    async registerGlobalCommands() {},
    ...overrides,
  };
}

describe("executeDiscordMessageToolAction", () => {
  const caps = discordCapabilityDescriptor();

  // ---------------------------------------------------------------------------
  // Existing action tests (post, get, edit, delete, threads)
  // ---------------------------------------------------------------------------

  it("post: JSON createMessage when no attachments", async () => {
    const calls: string[] = [];
    const transport = mockTransport({
      async createMessage(ch, body) {
        calls.push(`create:${ch}:${(body as { content: string }).content}`);
        return { id: "m1" };
      },
      async createMessageWithFiles() {
        throw new Error("unexpected multipart");
      },
    });
    const r = await executeDiscordMessageToolAction(
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
        assert.equal((body as { content: string }).content, "f");
        return { id: "m2" };
      },
    });
    const r = await executeDiscordMessageToolAction(
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

  it("rejects attachments when capability off", async () => {
    const transport = mockTransport();
    const noAtt = {
      ...caps,
      extensions: { ...caps.extensions, attachments: false },
    };
    const r = await executeDiscordMessageToolAction(
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

  it("returns error when session has no channel mapping", async () => {
    const transport = mockTransport();
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => undefined },
      "sess",
      { action: "post", content: "a" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.equal((r as { error: string }).error, "no_discord_channel_for_session");
  });

  it("get: single message by message_id", async () => {
    const transport = mockTransport({
      async getMessage(ch, mid) {
        assert.equal(ch, "chan-z");
        assert.equal(mid, "snow1");
        return {
          id: mid,
          channel_id: ch,
          content: "hello",
          timestamp: "t",
          author: { id: "a", username: "u", bot: false },
          attachments: [{ filename: "f.png" }],
        };
      },
      async getChannelMessages() {
        throw new Error("unexpected list");
      },
    });
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "chan-z" },
      "sess",
      { action: "get", message_id: "snow1" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    const msgs = (r as { messages: { id: string; content: string; attachment_count: number }[] }).messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.content, "hello");
    assert.equal(msgs[0]!.attachment_count, 1);
  });

  it("get: latest messages uses bound channel and limit", async () => {
    let lastQuery: { limit?: number } | undefined;
    const transport = mockTransport({
      async getMessage() {
        throw new Error("unexpected single");
      },
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
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "c99" },
      "sess",
      { action: "get", limit: 5 },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.deepEqual(lastQuery, { limit: 5 });
    assert.equal((r as { messages: unknown[] }).messages.length, 1);
  });

  it("get: anchor + list_direction passes cursor to Discord", async () => {
    let lastQuery: { before?: string; limit: number } | undefined;
    const transport = mockTransport({
      async getMessage() {
        throw new Error("unexpected single");
      },
      async getChannelMessages(_ch, q) {
        lastQuery = q as { before?: string; limit: number };
        return [];
      },
    });
    await executeDiscordMessageToolAction(
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
      async getChannelMessages() {
        throw new Error("unexpected");
      },
    });
    const r = await executeDiscordMessageToolAction(
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
    const r = await executeDiscordMessageToolAction(
      { capabilities: noGet, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "get", message_id: "x" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  // ---------------------------------------------------------------------------
  // react — add/remove emoji reactions
  // ---------------------------------------------------------------------------

  it("react: adds a reaction", async () => {
    let reacted: { ch: string; mid: string; emoji: string } | undefined;
    const transport = mockTransport({
      async createMessageReaction(ch, mid, emoji) {
        reacted = { ch, mid, emoji };
      },
    });
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "react", message_id: "m1", emoji: "✅" },
    );
    assert.deepEqual(r, { ok: true, message_id: "m1", channel_id: "ch1", emoji: "✅", removed: false });
    assert.deepEqual(reacted, { ch: "ch1", mid: "m1", emoji: "✅" });
  });

  it("react: removes a reaction when remove=true", async () => {
    let removed = false;
    const transport = mockTransport({
      async deleteMessageReaction() {
        removed = true;
      },
    });
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "react", message_id: "m1", emoji: "👀", remove: true },
    );
    assert.deepEqual(r, { ok: true, message_id: "m1", channel_id: "ch1", emoji: "👀", removed: true });
    assert.equal(removed, true);
  });

  it("react: rejected when capability off", async () => {
    const transport = mockTransport();
    const noReact = { ...caps, extensions: { ...caps.extensions, react: false } };
    const r = await executeDiscordMessageToolAction(
      { capabilities: noReact, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "react", message_id: "m1", emoji: "✅" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.equal((r as { error: string }).error, "react not supported on this platform");
  });

  it("react: requires emoji parameter", async () => {
    const transport = mockTransport();
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "react", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  // ---------------------------------------------------------------------------
  // reactions — read reactions on a message
  // ---------------------------------------------------------------------------

  it("reactions: returns users for a specific emoji", async () => {
    const transport = mockTransport({
      async getMessageReactions(_ch, _mid, _emoji) {
        return [
          { id: "u1", username: "alice", bot: false },
          { id: "u2", username: "bob", bot: true },
        ];
      },
    });
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "reactions", message_id: "m1", emoji: "✅" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    const reactions = (r as { reactions: { emoji: string; count: number; users: unknown[] }[] }).reactions;
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0]!.emoji, "✅");
    assert.equal(reactions[0]!.count, 2);
    assert.equal(reactions[0]!.users.length, 2);
  });

  it("reactions: returns all reactions summary when no emoji filter", async () => {
    const transport = mockTransport({
      async getMessage(_ch, _mid) {
        return {
          id: _mid,
          channel_id: _ch,
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
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "reactions", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    const reactions = (r as { reactions: { emoji: string; count: number; me: boolean }[] }).reactions;
    assert.equal(reactions.length, 2);
    assert.equal(reactions[0]!.emoji, "✅");
    assert.equal(reactions[0]!.count, 3);
    assert.equal(reactions[0]!.me, true);
    assert.equal(reactions[1]!.emoji, "fire:12345");
    assert.equal(reactions[1]!.count, 1);
  });

  it("reactions: rejected when capability off", async () => {
    const transport = mockTransport();
    const noReactions = { ...caps, extensions: { ...caps.extensions, reactions: false } };
    const r = await executeDiscordMessageToolAction(
      { capabilities: noReactions, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "reactions", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.equal((r as { error: string }).error, "reactions not supported on this platform");
  });

  // ---------------------------------------------------------------------------
  // search — filtered message fetch
  // ---------------------------------------------------------------------------

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
    const r = await executeDiscordMessageToolAction(
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
    const msgs = (r as { messages: { content: string }[] }).messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.content, "rollback deploy");
    assert.ok(capturedQuery);
    const q = capturedQuery as { content: string; author_id: string; min_id: string; limit: number };
    assert.equal(q.content, "rollback");
    assert.equal(q.author_id, "u1");
    assert.equal(q.min_id, "2026-03-30T00:00:00Z");
    assert.equal(q.limit, 10);
  });

  it("search: returns error when no guild context", async () => {
    const transport = mockTransport();
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "ch1" },
      "sess",
      { action: "search", query: "test" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.ok((r as { error: string }).error.includes("guild"));
  });

  it("search: rejected when capability off", async () => {
    const transport = mockTransport();
    const noSearch = { ...caps, extensions: { ...caps.extensions, search: false } };
    const r = await executeDiscordMessageToolAction(
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
    assert.equal((r as { error: string }).error, "search not supported on this platform");
  });

  it("search: defaults channel_ids to bound channel", async () => {
    let capturedQuery: unknown;
    const transport = mockTransport({
      async searchMessages(_guildId, query) {
        capturedQuery = query;
        return { total_results: 0, messages: [] };
      },
    });
    await executeDiscordMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "bound-ch",
        sessionToGuild: () => "g1",
      },
      "sess",
      { action: "search", query: "hello" },
    );
    const q = capturedQuery as { channel_id: string };
    assert.equal(q.channel_id, "bound-ch");
  });

  // ---------------------------------------------------------------------------
  // attachment-download — download file attachments
  // ---------------------------------------------------------------------------

  it("attachment-download: downloads first attachment by default", async () => {
    let downloadedUrl: string | undefined;
    let downloadedPath: string | undefined;
    const transport = mockTransport({
      async getMessage(_ch, _mid) {
        return {
          id: _mid,
          channel_id: _ch,
          content: "here's the log",
          timestamp: "t",
          author: { id: "u1", username: "tester" },
          attachments: [
            {
              id: "att1",
              filename: "error.log",
              url: "https://cdn.discord.com/attachments/ch1/att1/error.log",
              content_type: "text/plain",
              size: 4096,
            },
          ],
        };
      },
    });
    const r = await executeDiscordMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        downloadFile: async (url, path) => {
          downloadedUrl = url;
          downloadedPath = path;
          return 4096;
        },
      },
      "sess",
      { action: "attachment-download", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.equal((r as { filename: string }).filename, "error.log");
    assert.equal((r as { mimeType: string }).mimeType, "text/plain");
    assert.equal((r as { size: number }).size, 4096);
    assert.equal((r as { totalAttachments: number }).totalAttachments, 1);
    assert.equal(downloadedUrl, "https://cdn.discord.com/attachments/ch1/att1/error.log");
    assert.ok(downloadedPath);
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
            { id: "a1", filename: "first.txt", url: "https://cdn/first.txt", size: 100 },
            { id: "a2", filename: "second.csv", url: "https://cdn/second.csv", content_type: "text/csv", size: 200 },
          ],
        };
      },
    });
    const r = await executeDiscordMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "ch1",
        downloadFile: async () => 200,
      },
      "sess",
      { action: "attachment-download", message_id: "m1", filename: "second.csv" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.equal((r as { filename: string }).filename, "second.csv");
    assert.equal((r as { mimeType: string }).mimeType, "text/csv");
    assert.equal((r as { totalAttachments: number }).totalAttachments, 2);
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
            { id: "a1", filename: "only.txt", url: "https://cdn/only.txt", size: 10 },
          ],
        };
      },
    });
    const r = await executeDiscordMessageToolAction(
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
    assert.deepEqual((r as { available_filenames: string[] }).available_filenames, ["only.txt"]);
  });

  it("attachment-download: returns error when message has no attachments", async () => {
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
    const r = await executeDiscordMessageToolAction(
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
            { id: "a1", filename: "huge.bin", url: "https://cdn/huge.bin", size: 30 * 1024 * 1024 },
          ],
        };
      },
    });
    const r = await executeDiscordMessageToolAction(
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
    const noDownload = { ...caps, extensions: { ...caps.extensions, attachmentDownload: false } };
    const r = await executeDiscordMessageToolAction(
      { capabilities: noDownload, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "attachment-download", message_id: "m1" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.equal((r as { error: string }).error, "attachment-download not supported on this platform");
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
    const r = await executeDiscordMessageToolAction(
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
            { id: "a1", filename: "../../etc/passwd", url: "https://cdn/x", size: 10 },
          ],
        };
      },
    });
    const r = await executeDiscordMessageToolAction(
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
    // Filename should be sanitized — no path separators or ".."
    const filename = (r as { filename: string }).filename;
    assert.ok(!filename.includes(".."));
    assert.ok(!filename.includes("/"));
    assert.ok(savedPath);
    assert.ok(!savedPath!.includes(".."));
  });
});
