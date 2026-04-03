import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectDiscordGateway, type DiscordGatewayConnectOptions } from "../src/gateway-client";

/* ------------------------------------------------------------------ */
/*  Mock WebSocket that gives tests full control over the connection   */
/* ------------------------------------------------------------------ */

interface FakeSocket {
  /** Payloads sent by the client via ws.send(). */
  sent: string[];
  /** Fire the "open" event. */
  emitOpen(): void;
  /** Deliver a raw gateway payload to the client. */
  deliver(payload: object): void;
  /** Deliver op 10 HELLO with a long heartbeat so it doesn't fire during tests. */
  deliverHello(heartbeatMs?: number): void;
  /** Deliver op 0 READY with session_id and resume_gateway_url. */
  deliverReady(extra?: Record<string, unknown>): void;
  /** Deliver op 0 RESUMED. */
  deliverResumed(): void;
  /** Deliver op 11 Heartbeat ACK. */
  deliverAck(): void;
  /** Simulate the server closing the socket. */
  serverClose(code?: number): void;
  /** The close code the client passed to ws.close(), if any. */
  clientCloseCode: number | undefined;
}

function createFakeSocketFactory() {
  const sockets: FakeSocket[] = [];
  let nextSocketReady: ((s: FakeSocket) => void) | undefined;

  /** Returns a promise that resolves the next time createWebSocket is called. */
  function waitForSocket(): Promise<FakeSocket> {
    const last = sockets[sockets.length - 1];
    // If there's already an un-awaited socket, don't return it — we want the *next* one.
    return new Promise<FakeSocket>((r) => { nextSocketReady = r; });
  }

  function createWebSocket(url: string): WebSocket {
    const listeners = new Map<string, Set<(ev: unknown) => void>>();
    const on = (type: string, fn: (ev: unknown) => void) => {
      let s = listeners.get(type);
      if (!s) { s = new Set(); listeners.set(type, s); }
      s.add(fn);
    };
    const emit = (type: string, ev: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    };

    const fake: FakeSocket = {
      sent: [],
      clientCloseCode: undefined,
      emitOpen() { emit("open", {}); },
      deliver(payload: object) {
        emit("message", { data: JSON.stringify(payload) });
      },
      deliverHello(heartbeatMs = 600_000) {
        fake.deliver({ op: 10, d: { heartbeat_interval: heartbeatMs } });
      },
      deliverReady(extra?: Record<string, unknown>) {
        fake.deliver({
          op: 0, t: "READY", s: 1,
          d: {
            user: { id: "bot-123", username: "shoggoth" },
            session_id: "sess-abc",
            resume_gateway_url: "wss://resume.test",
            ...extra,
          },
        });
      },
      deliverResumed() {
        fake.deliver({ op: 0, t: "RESUMED", s: null });
      },
      deliverAck() {
        fake.deliver({ op: 11, d: null });
      },
      serverClose(code = 1006) {
        emit("close", { code, reason: "" });
      },
    };

    const ws = {
      addEventListener(type: string, fn: (ev: unknown) => void) {
        on(type, fn);
      },
      send(data: string) { fake.sent.push(data); },
      close(code?: number, _reason?: string) {
        fake.clientCloseCode = code;
        emit("close", { code, reason: _reason ?? "" });
      },
      get readyState() { return 1; },
    };

    sockets.push(fake);
    if (nextSocketReady) {
      const cb = nextSocketReady;
      nextSocketReady = undefined;
      cb(fake);
    }

    return ws as unknown as WebSocket;
  }

  return { sockets, createWebSocket, waitForSocket };
}

function baseFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ url: "wss://gateway.test/" }), { status: 200 })
  ) as unknown as typeof fetch;
}

function baseOpts(
  overrides: Partial<DiscordGatewayConnectOptions> & { createWebSocket: (url: string) => WebSocket },
): DiscordGatewayConnectOptions {
  return {
    botToken: "test-token",
    fetchFn: baseFetch(),
    onMessageCreate: () => {},
    ...overrides,
  };
}

/** Connect and complete the initial handshake, returning the session + first socket. */
async function connectAndHandshake(factory: ReturnType<typeof createFakeSocketFactory>) {
  const sessionP = connectDiscordGateway(baseOpts({ createWebSocket: factory.createWebSocket }));
  await vi.waitFor(() => expect(factory.sockets.length).toBeGreaterThan(0));
  const s0 = factory.sockets[0];
  s0.emitOpen();
  await vi.waitFor(() => expect(s0.sent.length).toBe(0)); // wait for open to propagate
  s0.deliverHello();
  await vi.waitFor(() => s0.sent.some((m) => m.includes('"op":2')));
  s0.deliverReady();
  const session = await sessionP;
  return { session, s0 };
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

describe("gateway reconnection", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /* -------------------------------------------------------------- */
  /*  op 7 — Reconnect                                               */
  /* -------------------------------------------------------------- */
  describe("op 7 (Reconnect)", () => {
    it("closes the socket and reconnects with resume on op 7", async () => {
      const factory = createFakeSocketFactory();
      const { session, s0 } = await connectAndHandshake(factory);

      const s1Promise = factory.waitForSocket();
      s0.deliver({ op: 7, d: null });

      // Advance past backoff.
      await vi.advanceTimersByTimeAsync(2_000);
      const s1 = await s1Promise;
      s1.emitOpen();
      s1.deliverHello();

      // Should send op 6 Resume, not op 2 Identify.
      await vi.waitFor(() => {
        expect(s1.sent.some((m) => m.includes('"op":6'))).toBe(true);
      });
      expect(s1.sent.some((m) => m.includes('"op":2'))).toBe(false);

      s1.deliverResumed();
      await session.stop();
    });
  });

  /* -------------------------------------------------------------- */
  /*  op 9 — Invalid Session                                         */
  /* -------------------------------------------------------------- */
  describe("op 9 (Invalid Session)", () => {
    it("resumes when d is true", async () => {
      const factory = createFakeSocketFactory();
      const { session, s0 } = await connectAndHandshake(factory);

      const s1Promise = factory.waitForSocket();
      s0.deliver({ op: 9, d: true });
      await vi.advanceTimersByTimeAsync(2_000);
      const s1 = await s1Promise;
      s1.emitOpen();
      s1.deliverHello();

      await vi.waitFor(() => {
        expect(s1.sent.some((m) => m.includes('"op":6'))).toBe(true);
      });

      s1.deliverResumed();
      await session.stop();
    });

    it("does a fresh identify when d is false", async () => {
      const factory = createFakeSocketFactory();
      const { session, s0 } = await connectAndHandshake(factory);

      const s1Promise = factory.waitForSocket();
      s0.deliver({ op: 9, d: false });
      await vi.advanceTimersByTimeAsync(2_000);
      const s1 = await s1Promise;
      s1.emitOpen();
      s1.deliverHello();

      await vi.waitFor(() => {
        expect(s1.sent.some((m) => m.includes('"op":2'))).toBe(true);
      });
      expect(s1.sent.some((m) => m.includes('"op":6'))).toBe(false);

      s1.deliverReady();
      await session.stop();
    });
  });

  /* -------------------------------------------------------------- */
  /*  Heartbeat ACK tracking                                         */
  /* -------------------------------------------------------------- */
  describe("heartbeat ACK tracking", () => {
    it("reconnects when a heartbeat ACK is missed", async () => {
      const factory = createFakeSocketFactory();
      const heartbeatMs = 5_000;

      const sessionP = connectDiscordGateway(baseOpts({ createWebSocket: factory.createWebSocket }));
      await vi.waitFor(() => expect(factory.sockets.length).toBeGreaterThan(0));
      const s0 = factory.sockets[0];
      s0.emitOpen();
      s0.deliverHello(heartbeatMs);
      await vi.waitFor(() => s0.sent.some((m) => m.includes('"op":2')));
      s0.deliverReady();
      const session = await sessionP;

      // First heartbeat fires — we do NOT deliver an ACK.
      const s1Promise = factory.waitForSocket();
      await vi.advanceTimersByTimeAsync(heartbeatMs);
      // The first heartbeat was sent, no ACK.
      expect(s0.sent.filter((m) => m.includes('"op":1')).length).toBe(1);

      // Second heartbeat tick detects missing ACK → close + reconnect.
      await vi.advanceTimersByTimeAsync(heartbeatMs);

      // Advance past backoff to let reconnect happen.
      await vi.advanceTimersByTimeAsync(2_000);
      const s1 = await s1Promise;
      expect(s1).toBeDefined();

      // Clean up.
      s1.emitOpen();
      s1.deliverHello();
      s1.deliverResumed();
      await session.stop();
    });
  });

  /* -------------------------------------------------------------- */
  /*  Auto-reconnect on unexpected close                             */
  /* -------------------------------------------------------------- */
  describe("auto-reconnect on unexpected close", () => {
    it("reconnects when the server closes the socket unexpectedly", async () => {
      const factory = createFakeSocketFactory();
      const { session, s0 } = await connectAndHandshake(factory);

      const s1Promise = factory.waitForSocket();
      s0.serverClose(1006);
      await vi.advanceTimersByTimeAsync(2_000);
      const s1 = await s1Promise;
      expect(s1).toBeDefined();

      s1.emitOpen();
      s1.deliverHello();
      s1.deliverResumed();
      await session.stop();
    });

    it("does NOT reconnect when stop() is called", async () => {
      const factory = createFakeSocketFactory();
      const { session } = await connectAndHandshake(factory);

      await session.stop();
      await vi.advanceTimersByTimeAsync(5_000);

      // Only the initial socket should exist.
      expect(factory.sockets.length).toBe(1);
    });
  });

  /* -------------------------------------------------------------- */
  /*  Exponential backoff                                            */
  /* -------------------------------------------------------------- */
  describe("exponential backoff", () => {
    it("increases delay on consecutive reconnect failures", async () => {
      const factory = createFakeSocketFactory();
      const { session, s0 } = await connectAndHandshake(factory);

      // Trigger first reconnect.
      let nextP = factory.waitForSocket();
      s0.serverClose(1006);

      // Attempt 1: backoff = 1s. Advancing 500ms should NOT produce a socket yet.
      await vi.advanceTimersByTimeAsync(500);
      expect(factory.sockets.length).toBe(1);
      await vi.advanceTimersByTimeAsync(600);
      const s1 = await nextP;

      // Fail the second connection during handshake to trigger another reconnect.
      nextP = factory.waitForSocket();
      s1.emitOpen();
      s1.serverClose(1006); // close before HELLO

      // Attempt 2: backoff = 2s.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(factory.sockets.length).toBe(2); // still only 2
      await vi.advanceTimersByTimeAsync(600);
      const s2 = await nextP;
      expect(s2).toBeDefined();

      // Clean up — complete the handshake on s2.
      s2.emitOpen();
      s2.deliverHello();
      s2.deliverResumed();
      await session.stop();
    });
  });

  /* -------------------------------------------------------------- */
  /*  Max reconnect attempts                                         */
  /* -------------------------------------------------------------- */
  describe("max reconnect attempts", () => {
    it("gives up after max consecutive failures", async () => {
      const factory = createFakeSocketFactory();
      const { session, s0 } = await connectAndHandshake(factory);

      // Kill the initial connection post-handshake → triggers scheduleReconnect.
      s0.serverClose(1006);

      // Each reconnect: socket opens, then immediately closes before HELLO.
      for (let i = 0; i < 10; i++) {
        // Advance just enough for this attempt's backoff (1s, 2s, 4s, ... capped at 30s).
        const delay = Math.min(1_000 * 2 ** i, 30_000);
        await vi.advanceTimersByTimeAsync(delay + 100);
        const sock = factory.sockets[factory.sockets.length - 1];
        // Open then immediately close — handshake never completes.
        sock.emitOpen();
        sock.serverClose(1006);
        await vi.advanceTimersByTimeAsync(0);
      }

      // After 10 failures, no more sockets should be created.
      const countBefore = factory.sockets.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(factory.sockets.length).toBe(countBefore);
      // 1 initial + 10 reconnect attempts = 11 total.
      expect(countBefore).toBe(11);
    });
  });

  /* -------------------------------------------------------------- */
  /*  Resume state                                                   */
  /* -------------------------------------------------------------- */
  describe("resume state", () => {
    it("stores session_id and resume_gateway_url from READY and uses them on reconnect", async () => {
      const urls: string[] = [];
      const factory = createFakeSocketFactory();
      const origCreate = factory.createWebSocket;
      const trackingCreate = (url: string) => {
        urls.push(url);
        return origCreate(url);
      };

      const sessionP = connectDiscordGateway(baseOpts({ createWebSocket: trackingCreate }));
      await vi.waitFor(() => expect(factory.sockets.length).toBeGreaterThan(0));
      const s0 = factory.sockets[0];
      s0.emitOpen();
      s0.deliverHello();
      await vi.waitFor(() => s0.sent.some((m) => m.includes('"op":2')));
      s0.deliverReady({ session_id: "sess-xyz", resume_gateway_url: "wss://resume.discord.gg" });
      const session = await sessionP;

      // Trigger reconnect.
      const s1Promise = factory.waitForSocket();
      s0.serverClose(1006);
      await vi.advanceTimersByTimeAsync(2_000);
      const s1 = await s1Promise;

      // Should connect to the resume URL.
      expect(urls[1]).toContain("resume.discord.gg");

      // Should send op 6 with the session_id.
      s1.emitOpen();
      s1.deliverHello();
      await vi.waitFor(() => {
        const resumePayload = s1.sent.find((m) => m.includes('"op":6'));
        expect(resumePayload).toBeDefined();
        expect(resumePayload).toContain("sess-xyz");
      });

      s1.deliverResumed();
      await session.stop();
    });

    it("resets reconnect counter on successful READY/RESUMED", async () => {
      const factory = createFakeSocketFactory();
      const { session, s0 } = await connectAndHandshake(factory);

      // Reconnect successfully.
      let nextP = factory.waitForSocket();
      s0.serverClose(1006);
      await vi.advanceTimersByTimeAsync(2_000);
      const s1 = await nextP;
      s1.emitOpen();
      s1.deliverHello();
      s1.deliverResumed();

      // Disconnect again — should still reconnect (counter was reset).
      nextP = factory.waitForSocket();
      s1.serverClose(1006);
      await vi.advanceTimersByTimeAsync(2_000);
      const s2 = await nextP;
      expect(s2).toBeDefined();

      s2.emitOpen();
      s2.deliverHello();
      s2.deliverResumed();
      await session.stop();
    });
  });
});
