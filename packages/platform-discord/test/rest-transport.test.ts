import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import {
  createDiscordRestTransport,
  discordRestRateLimitPolicy,
} from "../src/rest-transport";

describe("Discord REST transport", () => {
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    calls = [];
  });

  it("createMessage POSTs JSON with Bot authorization", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    const ref = await t.createMessage("ch1", { content: "hi" });
    assert.equal(ref.id, "msg-1");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/channels\/ch1\/messages$/);
    assert.equal(calls[0]!.init.method, "POST");
    const body = JSON.parse(String(calls[0]!.init.body)) as { content: string };
    assert.equal(body.content, "hi");
    const h = calls[0]!.init.headers as Headers;
    assert.equal(h.get("Authorization"), "Bot tok");
  });

  it("openDmChannel POSTs recipient_id and returns channel id", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "dm-channel-7" }), { status: 200 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    const id = await t.openDmChannel("347033761822801922");
    assert.equal(id, "dm-channel-7");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/users\/@me\/channels$/);
    assert.equal(calls[0]!.init.method, "POST");
    const body = JSON.parse(String(calls[0]!.init.body)) as { recipient_id: string };
    assert.equal(body.recipient_id, "347033761822801922");
  });

  it("editMessage PATCHes content", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    await t.editMessage("ch1", "m1", { content: "x" });
    assert.match(calls[0]!.url, /\/channels\/ch1\/messages\/m1$/);
    assert.equal(calls[0]!.init.method, "PATCH");
  });

  it("createMessage retries on 429 with retry_after then succeeds", async () => {
    let n = 0;
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      n++;
      if (n === 1) {
        return new Response(JSON.stringify({ retry_after: 0.01, message: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "msg-after-retry" }), { status: 201 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    const ref = await t.createMessage("ch1", { content: "hi" });
    assert.equal(ref.id, "msg-after-retry");
    assert.equal(calls.length, 2);
  });

  it("editMessage retries on 429 with Retry-After header then succeeds", async () => {
    let n = 0;
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      n++;
      if (n === 1) {
        return new Response("{}", {
          status: 429,
          headers: { "Retry-After": "0.01" },
        });
      }
      return new Response("{}", { status: 200 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    await t.editMessage("ch1", "m1", { content: "x" });
    assert.equal(calls.length, 2);
  });

  it("throws after max attempts when createMessage always gets 429", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ retry_after: 0.001 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    await assert.rejects(() => t.createMessage("c", { content: "a" }), /429/);
    assert.equal(calls.length, discordRestRateLimitPolicy.maxAttempts);
  });

  it("non-retryable 4xx fails without extra fetch calls", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("bad request", { status: 400 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    await assert.rejects(() => t.createMessage("c", { content: "a" }), /400/);
    assert.equal(calls.length, 1);
  });

  it("createMessageReaction PUTs encoded emoji and accepts 204", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), method: (init?.method as string) ?? "GET" });
      return new Response(null, { status: 204 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    await t.createMessageReaction("ch1", "m1", "✅");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "PUT");
    assert.match(calls[0]!.url, /\/reactions\//);
    assert.ok(calls[0]!.url.includes(encodeURIComponent("✅")));
  });

  it("deleteMessage DELETEs message endpoint", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    await t.deleteMessage("ch1", "m9");
    assert.match(calls[0]!.url, /\/channels\/ch1\/messages\/m9$/);
    assert.equal(calls[0]!.init.method, "DELETE");
  });

  it("createThreadFromMessage POSTs name and returns thread id", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "thread-1" }), { status: 201 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    const ref = await t.createThreadFromMessage("ch1", "m1", { name: "tname", auto_archive_duration: 60 });
    assert.equal(ref.id, "thread-1");
    assert.match(calls[0]!.url, /\/channels\/ch1\/messages\/m1\/threads$/);
    const body = JSON.parse(String(calls[0]!.init.body)) as { name: string; auto_archive_duration: number };
    assert.equal(body.name, "tname");
    assert.equal(body.auto_archive_duration, 60);
  });

  it("deleteChannel DELETEs channel", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    await t.deleteChannel("thread-z");
    assert.match(calls[0]!.url, /\/channels\/thread-z$/);
    assert.equal(calls[0]!.init.method, "DELETE");
  });

  it("getMessage GETs single message", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          id: "msg-9",
          channel_id: "ch1",
          content: "hi",
          timestamp: "t",
          author: { id: "u1" },
          attachments: [],
        }),
        { status: 200 },
      );
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    const j = await t.getMessage("ch1", "msg-9");
    assert.equal(j.id, "msg-9");
    assert.match(calls[0]!.url, /\/channels\/ch1\/messages\/msg-9$/);
    assert.equal(calls[0]!.init.method, "GET");
  });

  it("getChannelMessages GETs with query params", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify([
          { id: "a", channel_id: "ch1", content: "1", timestamp: "t", author: {}, attachments: [] },
        ]),
        { status: 200 },
      );
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    const rows = await t.getChannelMessages("ch1", { limit: 5, before: "snow" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "a");
    assert.match(calls[0]!.url, /\/channels\/ch1\/messages\?/);
    assert.match(calls[0]!.url, /limit=5/);
    assert.match(calls[0]!.url, /before=snow/);
  });

  it("createMessageWithFiles sends multipart form with payload_json", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "mf-1" }), { status: 200 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    const ref = await t.createMessageWithFiles(
      "ch1",
      { content: "see file" },
      [{ filename: "a.txt", data: new Uint8Array([97, 98]) }],
    );
    assert.equal(ref.id, "mf-1");
    assert.ok(calls[0]!.init.body instanceof FormData);
    const h = calls[0]!.init.headers as Headers;
    assert.equal(h.get("Authorization"), "Bot tok");
    assert.equal(h.get("Content-Type"), null);
  });

  it("triggerTypingIndicator POSTs to channel typing endpoint", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        method: (init?.method as string) ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(null, { status: 204 });
    };
    const t = createDiscordRestTransport({ botToken: "tok", fetchFn, apiBase: "https://example.com/v10" });
    await t.triggerTypingIndicator("ch-typing-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.url, /\/channels\/ch-typing-1\/typing$/);
    assert.equal(calls[0]!.body, "{}");
  });
});
