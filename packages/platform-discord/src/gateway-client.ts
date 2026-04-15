import type { DiscordInboundEvent, DiscordReactionAddEvent } from "./adapter";
import type { DiscordInteractionEvent } from "./interaction";
import { getLogger } from "@shoggoth/shared";
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

const log = getLogger("discord-gw");

const MAX_RECONNECT_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/**
 * Discord Gateway session with automatic reconnection, resume support,
 * heartbeat ACK tracking, and exponential backoff.
 */
export async function connectDiscordGateway(
  options: DiscordGatewayConnectOptions,
): Promise<DiscordGatewaySession> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const intents = options.intents ?? DISCORD_GATEWAY_INTENTS_DEFAULT;
  const allowBot = options.allowBotMessages ?? false;
  const WS = options.createWebSocket ?? ((url: string) => new WebSocket(url));

  // Fetch initial gateway URL.
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
  const defaultGatewayUrl = `${gwJson.url}?v=10&encoding=json`;

  // Session-level mutable state.
  let lastSeq: number | null = null;
  let sessionId: string | undefined;
  let resumeGatewayUrl: string | undefined;
  let botUserId: string | undefined;
  let intentionallyStopped = false;
  let consecutiveReconnects = 0;
  let reconnectPending = false;

  // Per-connection mutable state.
  let ws: WebSocket | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatAcked = true;

  // Resolved when the session is fully dead (intentional stop or max retries exhausted).
  let resolveSessionDone: (() => void) | undefined;
  const sessionDonePromise = new Promise<void>((r) => { resolveSessionDone = r; });

  function clearHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function closeSocket(code = 1000, reason = "shoggoth"): void {
    clearHeartbeat();
    try { ws?.close(code, reason); } catch { /* ignore */ }
  }

  function sendPayload(payload: object): void {
    try { ws?.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }

  function startHeartbeat(intervalMs: number): void {
    clearHeartbeat();
    heartbeatAcked = true;
    heartbeatTimer = setInterval(() => {
      if (!heartbeatAcked) {
        log.error("heartbeat ACK missed, reconnecting");
        closeSocket(4000, "zombie");
        return;
      }
      heartbeatAcked = false;
      sendPayload({ op: 1, d: lastSeq });
    }, intervalMs);
  }

  function sendIdentify(): void {
    sendPayload({
      op: 2,
      d: {
        token: options.botToken,
        intents,
        properties: { os: "linux", browser: "shoggoth", device: "shoggoth" },
      },
    });
  }

  function sendResume(): void {
    sendPayload({
      op: 6,
      d: { token: options.botToken, session_id: sessionId, seq: lastSeq },
    });
  }

  function handleDispatch(msg: GatewayPayload): void {
    if (msg.t === "READY") {
      const d = msg.d as Record<string, unknown> | null;
      const id = discordReadyPayloadToBotUserId(msg.d);
      if (id) botUserId = id;
      if (d && typeof d.session_id === "string") sessionId = d.session_id;
      if (d && typeof d.resume_gateway_url === "string") {
        resumeGatewayUrl = `${d.resume_gateway_url}?v=10&encoding=json`;
      }
      return;
    }
    if (msg.t === "RESUMED") return;
    if (msg.t === "MESSAGE_CREATE") {
      const ev = discordMessageCreateToInboundEvent(msg.d, { allowBotMessages: allowBot });
      if (ev) options.onMessageCreate(ev);
    } else if (msg.t === "MESSAGE_REACTION_ADD") {
      const ev = discordMessageReactionAddToEvent(msg.d);
      if (ev) options.onMessageReactionAdd?.(ev);
    } else if (msg.t === "INTERACTION_CREATE") {
      const ev = discordInteractionCreateToEvent(msg.d);
      if (ev) options.onInteractionCreate?.(ev);
    }
  }

  /**
   * Open a single WebSocket connection. Resolves once READY/RESUMED is received
   * (for the initial connect) or immediately for reconnect attempts that will
   * be driven by the message handler.
   */
  function openConnection(resume: boolean): Promise<void> {
    const url = resume && resumeGatewayUrl ? resumeGatewayUrl : defaultGatewayUrl;
    const socket = WS(url);
    ws = socket;
    heartbeatAcked = true;

    return new Promise<void>((resolve, reject) => {
      let handshakeComplete = false;
      const handshakeTimeout = setTimeout(() => {
        if (!handshakeComplete) {
          handshakeComplete = true;
          reject(new Error("Discord gateway HELLO/READY timeout"));
          closeSocket(4000, "timeout");
        }
      }, 30_000);

      function finishHandshake(): void {
        if (handshakeComplete) return;
        handshakeComplete = true;
        clearTimeout(handshakeTimeout);
        consecutiveReconnects = 0;
        resolve();
      }

      socket.addEventListener("open", () => {
        // Nothing to do — wait for HELLO (op 10).
      }, { once: true });

      socket.addEventListener("error", () => {
        if (!handshakeComplete) {
          handshakeComplete = true;
          clearTimeout(handshakeTimeout);
          reject(new Error("Discord gateway WebSocket error"));
        }
        // Post-handshake errors will trigger the close event.
      });

      let reconnectScheduled = false;

      socket.addEventListener("close", () => {
        clearHeartbeat();
        if (!handshakeComplete) {
          handshakeComplete = true;
          clearTimeout(handshakeTimeout);
          reject(new Error("Discord gateway WebSocket closed during handshake"));
        }
        if (!reconnectScheduled) {
          reconnectScheduled = true;
          if (!intentionallyStopped) {
            scheduleReconnect();
          } else {
            resolveSessionDone?.();
          }
        }
      }, { once: true });

      let helloReceived = false;

      socket.addEventListener("message", (ev: MessageEvent) => {
        const raw =
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        let msg: GatewayPayload;
        try { msg = JSON.parse(raw) as GatewayPayload; } catch { return; }

        if (typeof msg.s === "number") lastSeq = msg.s;

        // op 10 — Hello
        if (msg.op === 10 && !helloReceived) {
          helloReceived = true;
          const hello = msg.d as { heartbeat_interval?: number };
          const interval =
            typeof hello.heartbeat_interval === "number" ? hello.heartbeat_interval : 41_250;
          startHeartbeat(interval);
          if (resume && sessionId) {
            sendResume();
          } else {
            sendIdentify();
          }
          return;
        }

        // op 11 — Heartbeat ACK
        if (msg.op === 11) {
          heartbeatAcked = true;
          return;
        }

        // op 7 — Reconnect request from Discord
        if (msg.op === 7) {
          log.info("received op 7 Reconnect, closing for resume");
          closeSocket(4000, "reconnect requested");
          return;
        }

        // op 9 — Invalid Session
        if (msg.op === 9) {
          const resumable = msg.d === true;
          log.info("received op 9 Invalid Session", { resumable });
          if (!resumable) {
            // Clear resume state so next connect does a fresh identify.
            sessionId = undefined;
            resumeGatewayUrl = undefined;
            lastSeq = null;
          }
          closeSocket(4000, "invalid session");
          return;
        }

        // op 0 — Dispatch
        if (msg.op === 0) {
          if (msg.t === "READY" || msg.t === "RESUMED") {
            handleDispatch(msg);
            finishHandshake();
            return;
          }
          handleDispatch(msg);
        }
      });
    });
  }

  function scheduleReconnect(): void {
    if (reconnectPending) return;
    reconnectPending = true;
    if (intentionallyStopped) {
      resolveSessionDone?.();
      return;
    }
    if (consecutiveReconnects >= MAX_RECONNECT_ATTEMPTS) {
      log.error("exhausted reconnect attempts, giving up", { maxAttempts: MAX_RECONNECT_ATTEMPTS });
      resolveSessionDone?.();
      return;
    }
    const delay = backoffMs(consecutiveReconnects);
    consecutiveReconnects++;
    const attempt = consecutiveReconnects;
    const canResume = !!(sessionId && lastSeq !== null);
    log.info("scheduling reconnect", { attempt, maxAttempts: MAX_RECONNECT_ATTEMPTS, delayMs: delay, resume: canResume });
    setTimeout(() => {
      reconnectPending = false;
      if (intentionallyStopped) {
        resolveSessionDone?.();
        return;
      }
      openConnection(canResume).catch((err) => {
        log.error("reconnect attempt failed", { attempt, error: String(err) });
        // close event may not fire after a connection-level error; schedule next attempt directly.
        scheduleReconnect();
      });
    }, delay);
  }

  // Initial connection — must succeed or throw.
  await openConnection(false);

  const session: DiscordGatewaySession = {
    stop: async () => {
      if (intentionallyStopped) return;
      intentionallyStopped = true;
      closeSocket(1000, "shoggoth shutdown");
      await sessionDonePromise;
    },
    getBotUserId: () => botUserId,
  };

  return session;
}
