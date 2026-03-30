import type { DiscordInboundEvent, DiscordReactionAddEvent } from "./adapter";
import type { DiscordInteractionEvent } from "./interaction";
import {
  discordMessageCreateToInboundEvent,
  discordMessageReactionAddToEvent,
  discordInteractionCreateToEvent,
  discordReadyPayloadToBotUserId,
  DISCORD_GATEWAY_INTENTS_DEFAULT,
} from "./gateway-payload";

export interface DiscordGatewayConnectOptions {
  readonly botToken: string;
  readonly intents?: number;
  readonly onMessageCreate: (ev: DiscordInboundEvent) => void;
  readonly onMessageReactionAdd?: (ev: DiscordReactionAddEvent) => void;
  readonly onInteractionCreate?: (ev: DiscordInteractionEvent) => void;
  /** Default false: ignore bot-authored messages to avoid accidental feedback loops. */
  readonly allowBotMessages?: boolean;
  readonly fetchFn?: typeof fetch;
  /**
   * Override WebSocket construction (tests). Default uses global `WebSocket` (Node 22+).
   */
  readonly createWebSocket?: (url: string) => WebSocket;
}

export interface DiscordGatewaySession {
  readonly stop: () => Promise<void>;
  /** Bot user snowflake from Gateway `READY` (or undefined if not received). */
  readonly getBotUserId: () => string | undefined;
}

interface GatewayPayload {
  readonly op: number;
  readonly d: unknown;
  readonly t?: string;
  readonly s?: number | null;
}

/**
 * Minimal Discord Gateway session: JSON encoding, heartbeat, MESSAGE_CREATE and
 * MESSAGE_REACTION_ADD dispatch.
 */
export async function connectDiscordGateway(
  options: DiscordGatewayConnectOptions,
): Promise<DiscordGatewaySession> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const intents = options.intents ?? DISCORD_GATEWAY_INTENTS_DEFAULT;
  const allowBot = options.allowBotMessages ?? false;
  const WS = options.createWebSocket ?? ((url: string) => new WebSocket(url));

  const gwRes = await fetchFn("https://discord.com/api/v10/gateway/bot", {
    headers: { Authorization: `Bot ${options.botToken}` },
  });
  if (!gwRes.ok) {
    const text = await gwRes.text();
    throw new Error(`Discord gateway/bot ${gwRes.status}: ${text}`);
  }
  const gwJson = (await gwRes.json()) as { url?: string };
  if (typeof gwJson.url !== "string") {
    throw new Error("Discord gateway/bot: missing url");
  }

  const wsUrl = `${gwJson.url}?v=10&encoding=json`;
  const ws = WS(wsUrl);

  let lastSeq: number | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let helloReceived = false;
  let botUserId: string | undefined;

  const stopPromise = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve());
  });

  const session: DiscordGatewaySession = {
    stop: async () => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      try {
        ws.close(1000, "shoggoth shutdown");
      } catch {
        /* ignore */
      }
      await stopPromise;
    },
    getBotUserId: () => botUserId,
  };

  const handshakePromise = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Discord gateway HELLO/READY timeout")), 30_000);
    const finish = () => {
      clearTimeout(t);
      resolve();
    };

    ws.addEventListener("message", (ev: MessageEvent) => {
      const raw =
        typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      let msg: GatewayPayload;
      try {
        msg = JSON.parse(raw) as GatewayPayload;
      } catch {
        return;
      }

      if (typeof msg.s === "number") lastSeq = msg.s;

      if (msg.op === 10 && !helloReceived) {
        helloReceived = true;
        const hello = msg.d as { heartbeat_interval?: number };
        const interval =
          typeof hello.heartbeat_interval === "number" ? hello.heartbeat_interval : 41_250;
        heartbeatTimer = setInterval(() => {
          try {
            ws.send(JSON.stringify({ op: 1, d: lastSeq }));
          } catch {
            /* ignore */
          }
        }, interval);

        const identify = {
          op: 2,
          d: {
            token: options.botToken,
            intents,
            properties: {
              os: "linux",
              browser: "shoggoth",
              device: "shoggoth",
            },
          },
        };
        ws.send(JSON.stringify(identify));
        return;
      }

      if (msg.op === 0 && msg.t === "READY") {
        const id = discordReadyPayloadToBotUserId(msg.d);
        if (id) botUserId = id;
        finish();
        return;
      }

      if (msg.op === 0 && msg.t === "MESSAGE_CREATE") {
        const inbound = discordMessageCreateToInboundEvent(msg.d, { allowBotMessages: allowBot });
        if (inbound) options.onMessageCreate(inbound);
        return;
      }

      if (msg.op === 0 && msg.t === "MESSAGE_REACTION_ADD") {
        const rev = discordMessageReactionAddToEvent(msg.d);
        if (rev) options.onMessageReactionAdd?.(rev);
      }

      if (msg.op === 0 && msg.t === "INTERACTION_CREATE") {
        const iev = discordInteractionCreateToEvent(msg.d);
        if (iev) options.onInteractionCreate?.(iev);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("Discord gateway WebSocket error")),
      { once: true },
    );
  });

  await handshakePromise;

  return session;
}
