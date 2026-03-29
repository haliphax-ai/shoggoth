import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  createDiscordRestTransport,
  discordRestRateLimitPolicy,
} from "../src/discord/rest-transport";

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
});
