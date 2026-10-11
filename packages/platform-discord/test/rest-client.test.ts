import { describe, it, vi } from "vitest";
import assert from "node:assert";
import {
  createDiscordRestClient,
  discordRestRateLimitPolicy,
  DiscordRestError,
  RateLimitedError,
  NotFoundError,
  MissingPermissionsError,
  ServerError,
  QueueTimeoutError,
  NetworkError,
} from "../src/rest-client";

type FetchCall = { url: string; init: RequestInit };

function recorder(
  impl: (url: string, init: RequestInit, callIndex: number) => Response | Promise<Response>,
): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    const i = calls.length;
    calls.push({ url: String(url), init: init ?? {} });
    return impl(String(url), init ?? {}, i);
  };
  return { fetchFn, calls };
}

function okHeaders(over: Record<string, string> = {}): Record<string, string> {
  return { "X-RateLimit-Bucket": "bkt", "X-RateLimit-Limit": "5", ...over };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Discord REST client", () => {
  describe("basics", () => {
    it("sends JSON with Bot authorization and Content-Type", async () => {
      const { fetchFn, calls } = recorder(() => json({ id: "m1" }));
      const c = createDiscordRestClient({
        botToken: "tok",
        fetchFn,
        apiBase: "https://example.com/v10",
      });
      const res = await c.request({
        operation: "createMessage",
        method: "POST",
        path: "/channels/ch1/messages",
        routeKey: "POST /channels/ch1/messages",
        body: JSON.stringify({ content: "hi" }),
      });
      const j = (await res.json()) as { id: string };
      assert.equal(j.id, "m1");
      assert.equal(calls.length, 1);
      const h = calls[0]!.init.headers as Headers;
      assert.equal(h.get("Authorization"), "Bot tok");
      assert.equal(h.get("Content-Type"), "application/json");
    });

    it("does not set Content-Type for FormData bodies", async () => {
      const { fetchFn, calls } = recorder(() => json({ id: "m1" }));
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const form = new FormData();
      form.append("payload_json", "{}");
      await c.request({
        operation: "createMessageWithFiles",
        method: "POST",
        path: "/channels/ch1/messages",
        routeKey: "POST /channels/ch1/messages",
        body: form,
      });
      const h = calls[0]!.init.headers as Headers;
      assert.equal(h.get("Content-Type"), null);
    });
  });

  describe("typed error taxonomy", () => {
    const cases: Array<{
      status: number;
      cls: unknown;
      kind: string;
    }> = [
      { status: 404, cls: NotFoundError, kind: "not_found" },
      { status: 403, cls: MissingPermissionsError, kind: "missing_permissions" },
      { status: 500, cls: ServerError, kind: "server_error" },
      { status: 400, cls: DiscordRestError, kind: "http" },
    ];

    for (const { status, cls, kind } of cases) {
      it(`classifies HTTP ${status} as ${kind}`, async () => {
        const { fetchFn } = recorder(() => new Response("boom", { status }));
        const c = createDiscordRestClient({ botToken: "tok", fetchFn });
        const err = await c
          .request({
            operation: "createMessage",
            method: "POST",
            path: "/channels/c/messages",
            routeKey: "POST /channels/c/messages",
          })
          .then(
            () => null,
            (e: unknown) => e,
          );
        assert.ok(err instanceof (cls as new (...a: never[]) => Error));
        assert.ok(err instanceof DiscordRestError);
        assert.equal((err as DiscordRestError).kind, kind);
        assert.equal((err as DiscordRestError).status, status);
        assert.match((err as Error).message, new RegExp(String(status)));
      });
    }

    it("wraps fetch failures as NetworkError", async () => {
      const fetchFn: typeof fetch = async () => {
        throw new Error("ECONNREFUSED");
      };
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const err = await c
        .request({
          operation: "createMessage",
          method: "POST",
          path: "/c",
          routeKey: "POST /c",
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof NetworkError);
      assert.equal((err as DiscordRestError).kind, "network");
      assert.match((err as Error).message, /ECONNREFUSED/);
    });

    it("exhausting 429 retries rejects with RateLimitedError", async () => {
      const { fetchFn, calls } = recorder(() =>
        json({ retry_after: 0.001, message: "rate limited" }, 429),
      );
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const err = await c
        .request({
          operation: "createMessage",
          method: "POST",
          path: "/channels/c/messages",
          routeKey: "POST /channels/c/messages",
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof RateLimitedError);
      assert.equal((err as DiscordRestError).kind, "rate_limited");
      assert.equal((err as DiscordRestError).status, 429);
      assert.match((err as Error).message, /429/);
      assert.equal(calls.length, discordRestRateLimitPolicy.maxAttempts);
    });
  });

  describe("bucket metering", () => {
    it("waits for the bucket reset before dispatching the next request", async () => {
      const started: number[] = [];
      const { fetchFn } = recorder((_url, _init, i) => {
        started.push(Date.now());
        if (i === 0) {
          return json(
            { id: "m1" },
            200,
            okHeaders({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.15" }),
          );
        }
        return json({ id: "m2" }, 200, okHeaders({ "X-RateLimit-Remaining": "4" }));
      });
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const spec = {
        operation: "createMessage",
        method: "POST",
        path: "/channels/ch1/messages",
        routeKey: "POST /channels/ch1/messages",
        body: JSON.stringify({ content: "x" }),
      };
      const p1 = c.request(spec);
      const p2 = c.request(spec);
      await Promise.all([p1, p2]);
      assert.equal(started.length, 2);
      // Second dispatch must wait for the advertised reset window.
      assert.ok(started[1]! - started[0]! >= 100, `gap was ${started[1]! - started[0]!}ms`);
    });

    it("shares a bucket across routes once the hash is learned", async () => {
      const started: number[] = [];
      const { fetchFn } = recorder((_url, _init, i) => {
        started.push(Date.now());
        if (i === 1) {
          // Second request exhausts the shared bucket for 150ms.
          return json(
            { id: "m2" },
            200,
            okHeaders({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.15" }),
          );
        }
        return json({ id: "ok" }, 200, okHeaders({ "X-RateLimit-Remaining": "4" }));
      });
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      // Warm both routes: each response advertises the same bucket hash.
      await c.request({
        operation: "getChannelMessages",
        method: "GET",
        path: "/channels/ch1/messages?limit=1",
        routeKey: "GET /channels/ch1/messages",
      });
      await c.request({
        operation: "createMessage",
        method: "POST",
        path: "/channels/ch1/messages",
        routeKey: "POST /channels/ch1/messages",
      });
      // Third: back on the GET route — the POST response exhausted the shared
      // bucket, so this must wait for the reset window.
      const before = started.length;
      await c.request({
        operation: "getChannelMessages",
        method: "GET",
        path: "/channels/ch1/messages?limit=2",
        routeKey: "GET /channels/ch1/messages",
      });
      assert.equal(started.length, before + 1);
      const gap = started[started.length - 1]! - started[started.length - 2]!;
      assert.ok(gap >= 100, `gap was ${gap}ms`);
    });
  });

  describe("priority lanes", () => {
    it("dispatches user-lane requests ahead of queued background requests", async () => {
      const bodies: Array<string | null> = [];
      const { fetchFn } = recorder((_url, init, i) => {
        bodies.push(init.body == null ? null : String(init.body));
        if (i === 0) {
          return json(
            { id: "seed" },
            200,
            okHeaders({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.1" }),
          );
        }
        return json({ id: "ok" }, 200, okHeaders({ "X-RateLimit-Remaining": "4" }));
      });
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const base = {
        method: "POST",
        path: "/channels/ch1/messages",
        routeKey: "POST /channels/ch1/messages",
      };
      // Seed: exhausts the bucket.
      await c.request({ operation: "createMessage", ...base, body: JSON.stringify({ seed: 1 }) });
      // Queue a background probe first, then a user send.
      const bg = c.request({
        operation: "probe",
        ...base,
        priority: "background",
        body: JSON.stringify({ probe: 1 }),
      });
      const user = c.request({
        operation: "createMessage",
        ...base,
        priority: "user",
        body: JSON.stringify({ user: 1 }),
      });
      await Promise.all([bg, user]);
      assert.equal(bodies.length, 3);
      // User lane outranks background despite being enqueued second.
      assert.deepEqual(bodies[1], JSON.stringify({ user: 1 }));
      assert.deepEqual(bodies[2], JSON.stringify({ probe: 1 }));
    });
  });

  describe("edit coalescing", () => {
    it("coalesces queued edits to the same message (latest wins, one in flight)", async () => {
      let release!: (r: Response) => void;
      const bodies: string[] = [];
      const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        if (bodies.length === 1) {
          return new Promise<Response>((res) => {
            release = res;
          });
        }
        return json({ id: "m1" });
      }) as unknown as typeof fetch;
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const edit = (content: string) =>
        c.request({
          operation: "editMessage",
          method: "PATCH",
          path: "/channels/ch1/messages/m1",
          routeKey: "PATCH /channels/ch1/messages/:id",
          coalesceKey: "edit:ch1:m1",
          body: JSON.stringify({ content }),
        });

      const p1 = edit("first");
      await vi.waitFor(() => assert.equal(bodies.length, 1));
      const p2 = edit("second");
      const p3 = edit("third");
      await sleep(10);
      // Only one request in flight; the queued edit was superseded, not sent.
      assert.equal(bodies.length, 1);
      release(json({ id: "m1" }));
      await Promise.all([p1, p2, p3]);
      // Exactly two network calls: the in-flight one and the latest queued one.
      assert.equal(bodies.length, 2);
      assert.equal(JSON.parse(bodies[0]!).content, "first");
      assert.equal(JSON.parse(bodies[1]!).content, "third");
    });

    it("applies the coalesce deadline to edits that wait too long", async () => {
      const { fetchFn, calls } = recorder(() =>
        json(
          { id: "seed" },
          200,
          okHeaders({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "5" }),
        ),
      );
      const c = createDiscordRestClient({
        botToken: "tok",
        fetchFn,
        policy: { coalesceDeadlineMs: 50 },
      });
      // Seed the PATCH route (learn its bucket hash) with an exhausted window
      // so the queued edit below has to wait on the same bucket.
      await c.request({
        operation: "editMessage",
        method: "PATCH",
        path: "/channels/ch1/messages/m0",
        routeKey: "PATCH /channels/ch1/messages/:id",
      });
      const err = await c
        .request({
          operation: "editMessage",
          method: "PATCH",
          path: "/channels/ch1/messages/m1",
          routeKey: "PATCH /channels/ch1/messages/:id",
          coalesceKey: "edit:ch1:m1",
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof QueueTimeoutError);
      assert.equal((err as DiscordRestError).kind, "queue_timeout");
      // The stale edit was never dispatched.
      assert.equal(calls.length, 1);
    });
  });

  describe("global rate limit", () => {
    it("pauses every bucket on a global 429", async () => {
      const started: number[] = [];
      let release429!: (r: Response) => void;
      const { fetchFn, calls } = recorder((_url, _init, i) => {
        started.push(Date.now());
        if (i === 0) {
          // Hold the first response until the test releases it, so the
          // global pause is provably active before p2 is enqueued.
          return new Promise<Response>((res) => {
            release429 = res;
          });
        }
        return json({ id: "m2" }, 200, okHeaders());
      });
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const t0 = Date.now();
      const p1 = c
        .request({
          operation: "createMessage",
          method: "POST",
          path: "/channels/a/messages",
          routeKey: "POST /channels/a/messages",
        })
        .catch(() => undefined);
      await vi.waitFor(() => assert.equal(started.length, 1));
      // Release the global 429 and let the client process it.
      release429(json({ retry_after: 0.15, global: true, message: "rate limited" }, 429));
      await sleep(20);
      // Different channel while the global pause is active.
      const p2 = c.request({
        operation: "createMessage",
        method: "POST",
        path: "/channels/b/messages",
        routeKey: "POST /channels/b/messages",
      });
      await Promise.all([p1, p2]);
      // 429 attempt + retried attempt + the other channel's request.
      assert.equal(started.length, 3);
      assert.ok(started[1]! - t0 >= 100, `gap was ${started[1]! - t0}ms`);
      // 429 attempt + retried attempt + the other channel's request.
      assert.equal(calls.length, 3);
    });
  });

  describe("retry behavior (single backoff mechanism)", () => {
    it("retries 429 with retry_after then succeeds", async () => {
      const { fetchFn, calls } = recorder((_u, _i, i) =>
        i === 0
          ? json({ retry_after: 0.01, message: "rate limited" }, 429)
          : json({ id: "after-retry" }, 201),
      );
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const res = await c.request({
        operation: "createMessage",
        method: "POST",
        path: "/channels/c/messages",
        routeKey: "POST /channels/c/messages",
      });
      const j = (await res.json()) as { id: string };
      assert.equal(j.id, "after-retry");
      assert.equal(calls.length, 2);
    });

    it("retries 429 signaled via Retry-After header then succeeds", async () => {
      const { fetchFn, calls } = recorder((_u, _i, i) =>
        i === 0
          ? new Response("{}", { status: 429, headers: { "Retry-After": "0.01" } })
          : json({}),
      );
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      await c.request({
        operation: "editMessage",
        method: "PATCH",
        path: "/channels/c/messages/m",
        routeKey: "PATCH /channels/c/messages/:id",
      });
      assert.equal(calls.length, 2);
    });

    it("retries 503 with Retry-After then succeeds", async () => {
      const { fetchFn, calls } = recorder((_u, _i, i) =>
        i === 0
          ? new Response("overloaded", {
              status: 503,
              headers: { "Retry-After": "0.01" },
            })
          : json({}),
      );
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      await c.request({
        operation: "createMessage",
        method: "POST",
        path: "/channels/c/messages",
        routeKey: "POST /channels/c/messages",
      });
      assert.equal(calls.length, 2);
    });

    it("503 without Retry-After is a terminal ServerError", async () => {
      const { fetchFn, calls } = recorder(() => new Response("overloaded", { status: 503 }));
      const c = createDiscordRestClient({ botToken: "tok", fetchFn });
      const err = await c
        .request({
          operation: "createMessage",
          method: "POST",
          path: "/channels/c/messages",
          routeKey: "POST /channels/c/messages",
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof ServerError);
      assert.equal(calls.length, 1);
    });
  });
});
