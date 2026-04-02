import { describe, it } from "vitest";
import assert from "node:assert";
import { connectDiscordGateway } from "../src/gateway-client";

describe("connectDiscordGateway", () => {
  it("completes HELLO, sends IDENTIFY, and forwards MESSAGE_CREATE", async () => {
    const sent: string[] = [];
    let sock: {
      deliverHello(): void;
      deliverMessageCreate(): void;
      close(): void;
    } | undefined;

    const createWebSocket = (_url: string): WebSocket => {
      const listeners = new Map<string, Set<(ev: { data: string }) => void>>();
      const on = (type: string, fn: (ev: { data: string }) => void) => {
        let s = listeners.get(type);
        if (!s) {
          s = new Set();
          listeners.set(type, s);
        }
        s.add(fn);
      };
      const emit = (type: string, ev: { data: string }) => {
        for (const fn of listeners.get(type) ?? []) fn(ev);
      };

      const fake = {
        addEventListener(type: string, fn: (ev: { data: string }) => void) {
          if (type === "message" || type === "open" || type === "error" || type === "close") {
            on(type, fn);
          }
        },
        send(data: string) {
          sent.push(data);
        },
        close() {
          emit("close", { data: "" });
        },
        deliverHello() {
          emit("message", {
            data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }),
          });
        },
        deliverReady() {
          emit("message", {
            data: JSON.stringify({
              op: 0,
              t: "READY",
              d: { user: { id: "bot-ready-1", username: "shoggoth" } },
            }),
          });
        },
        deliverMessageCreate() {
          emit("message", {
            data: JSON.stringify({
              op: 0,
              t: "MESSAGE_CREATE",
              s: 2,
              d: {
                id: "m2",
                channel_id: "c2",
                guild_id: "g2",
                author: { id: "u2", bot: false },
                content: "ping",
                timestamp: "2026-03-27T12:00:00.000000+00:00",
              },
            }),
          });
        },
      };
      sock = fake;
      queueMicrotask(() => {
        for (const fn of listeners.get("open") ?? []) (fn as (e: { data: string }) => void)({ data: "" });
      });
      return fake as unknown as WebSocket;
    };

    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ url: "wss://gateway.test/" }), { status: 200 });

    const inbound: string[] = [];
    const sessionP = connectDiscordGateway({
      botToken: "test-token",
      intents: 37377,
      fetchFn,
      createWebSocket,
      onMessageCreate: (ev) => {
        inbound.push(ev.messageId);
      },
    });

    await new Promise<void>((r) => setImmediate(r));
    assert.ok(sock);
    sock!.deliverHello();
    await new Promise<void>((r) => setImmediate(r));
    assert.ok(sent.some((s) => s.includes('"op":2')));

    sock!.deliverReady();
    await new Promise<void>((r) => setImmediate(r));

    const session = await sessionP;
    assert.equal(session.getBotUserId(), "bot-ready-1");
    sock!.deliverMessageCreate();
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(inbound, ["m2"]);

    await session.stop();
  });
});
