import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HealthRegistry,
  createSqliteProbe,
  createModelEndpointProbe,
} from "../src/health";
import { createDiscordProbe } from "@shoggoth/platform-discord";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("HealthRegistry", () => {
  it("ready when all pass", async () => {
    const h = new HealthRegistry();
    h.register({
      name: "a",
      async check() {
        return { name: "a", status: "pass" };
      },
    });
    const s = await h.snapshot();
    assert.equal(s.ready, true);
    assert.equal(s.ok, true);
  });

  it("not ready on fail", async () => {
    const h = new HealthRegistry();
    h.register({
      name: "a",
      async check() {
        return { name: "a", status: "fail", detail: "x" };
      },
    });
    const s = await h.snapshot();
    assert.equal(s.ready, false);
    assert.equal(s.ok, false);
  });

  it("skipped ignored for readiness", async () => {
    const h = new HealthRegistry();
    h.register({
      name: "opt",
      async check() {
        return { name: "opt", status: "skipped" };
      },
    });
    const s = await h.snapshot();
    assert.equal(s.ready, true);
  });

  it("sqlite probe skipped without path", async () => {
    const p = createSqliteProbe({ getPath: () => undefined });
    const c = await p.check();
    assert.equal(c.status, "skipped");
  });

  it("sqlite probe pass for existing writable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shoggoth-h-"));
    const dbPath = join(dir, "state.db");
    await writeFile(dbPath, "", "utf8");
    const p = createSqliteProbe({ getPath: () => dbPath });
    const c = await p.check();
    assert.equal(c.status, "pass");
    await rm(dir, { recursive: true });
  });

  it("discord probe skipped without token", async () => {
    const p = createDiscordProbe({ getToken: () => undefined });
    const c = await p.check();
    assert.equal(c.status, "skipped");
  });

  it("discord probe pass on 200 with user detail", async () => {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), "https://discord.com/api/v10/users/@me");
      const auth = new Headers((init as RequestInit).headers as HeadersInit).get("Authorization");
      assert.equal(auth, "Bot t");
      return new Response(JSON.stringify({ username: "rook", id: "42" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const p = createDiscordProbe({ getToken: () => "t" });
    const c = await p.check();
    assert.equal(c.status, "pass");
    assert.equal(c.detail, "rook (42)");
  });

  it("discord probe fail on 401", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
    const p = createDiscordProbe({ getToken: () => "bad" });
    const c = await p.check();
    assert.equal(c.status, "fail");
    assert.match(c.detail ?? "", /401/);
  });

  it("discord probe fail on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const p = createDiscordProbe({ getToken: () => "t" });
    const c = await p.check();
    assert.equal(c.status, "fail");
    assert.equal(c.detail, "ECONNRESET");
  });

  it("model probe skipped without base URL", async () => {
    const p = createModelEndpointProbe({ getBaseUrl: () => undefined });
    const c = await p.check();
    assert.equal(c.status, "skipped");
  });

  it("model probe pass on HEAD 200", async () => {
    globalThis.fetch = (async (_url, init) => {
      assert.equal((init as RequestInit).method, "HEAD");
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const p = createModelEndpointProbe({ getBaseUrl: () => "https://api.example.com/v1" });
    const c = await p.check();
    assert.equal(c.status, "pass");
    assert.equal(c.detail, "HTTP 200");
  });

  it("model probe falls back from HEAD 405 to GET", async () => {
    let headSeen = false;
    globalThis.fetch = (async (_url, init) => {
      const m = (init as RequestInit).method;
      if (m === "HEAD") {
        headSeen = true;
        return new Response(null, { status: 405 });
      }
      assert.equal(m, "GET");
      assert.equal(new Headers((init as RequestInit).headers).get("Accept"), "*/*");
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const p = createModelEndpointProbe({ getBaseUrl: () => "https://api.example.com/v1" });
    const c = await p.check();
    assert.equal(headSeen, true);
    assert.equal(c.status, "pass");
  });

  it("model probe prepends http for host-only base URL", async () => {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:11434/v1/models");
      assert.equal((init as RequestInit).method, "HEAD");
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const p = createModelEndpointProbe({ getBaseUrl: () => "127.0.0.1:11434" });
    const c = await p.check();
    assert.equal(c.status, "pass");
  });

  it("model probe warn on 401", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    const p = createModelEndpointProbe({ getBaseUrl: () => "https://api.example.com/v1" });
    const c = await p.check();
    assert.equal(c.status, "warn");
    assert.match(c.detail ?? "", /401/);
  });

  it("model probe fail on 503", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    const p = createModelEndpointProbe({ getBaseUrl: () => "https://api.example.com/v1" });
    const c = await p.check();
    assert.equal(c.status, "fail");
    assert.equal(c.detail, "HTTP 503");
  });

  it("model probe anthropic origin probes root not v1/models", async () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8000";
    try {
      globalThis.fetch = (async (url, init) => {
        assert.equal(String(url), "http://127.0.0.1:8000/");
        assert.equal((init as RequestInit).method, "HEAD");
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      const p = createModelEndpointProbe({ getBaseUrl: () => "http://127.0.0.1:8000" });
      const c = await p.check();
      assert.equal(c.status, "pass");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });
});
