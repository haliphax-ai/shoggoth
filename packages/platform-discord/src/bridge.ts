import { isValidAgentSessionUrn, parseAgentSessionUrn } from "@shoggoth/shared";
import type { InternalMessage } from "@shoggoth/messaging";
import { createAgentToAgentBus, type AgentToAgentBus } from "@shoggoth/messaging";
import { discordCapabilityDescriptor, type MessagingAdapterCapabilities } from "./capabilities";
import { createOutboundSender, type OutboundSender } from "./outbound";
import { createDiscordStreamingOutbound } from "./streaming";
import {
  createDiscordAdapter,
  type DiscordInboundEvent,
  type DiscordReactionAddEvent,
  type DiscordSessionRoute,
} from "./adapter";
export type { DiscordReactionAddEvent, DiscordSessionRoute } from "./adapter";
import type { DiscordInteractionEvent } from "./interaction";
import { connectDiscordGateway, type DiscordGatewaySession } from "./gateway-client";
import { DISCORD_GATEWAY_INTENTS_DEFAULT } from "./gateway-payload";
import { createDiscordRestTransport } from "./rest-transport";
import type { DiscordRestTransport } from "./transport";
import { fetchDiscordBotUserId } from "./bot-user";
import { DiscordRoutesConfigurationError } from "./messaging-urn-policy";
import { getMessagingPlatformUrnPolicy } from "@shoggoth/messaging";

/** Minimal logger surface for the Discord bridge (daemon `Logger` is structurally compatible). */
export interface DiscordBridgeLogger {
  readonly debug: (msg: string, fields?: Record<string, unknown>) => void;
  readonly info: (msg: string, fields?: Record<string, unknown>) => void;
  readonly warn: (msg: string, fields?: Record<string, unknown>) => void;
  readonly error: (msg: string, fields?: Record<string, unknown>) => void;
}

function applyDiscordTransportEnvelope(
  msg: InternalMessage,
  ev: DiscordInboundEvent,
  botUserId: string | undefined,
  ownerUserId: string | undefined,
): InternalMessage {
  const ownerTrim = ownerUserId?.trim();
  const bid = botUserId?.trim();
  return {
    ...msg,
    extensions: {
      ...msg.extensions,
      discord: {
        authorSnowflake: ev.authorId,
        authorIsBot: ev.authorIsBot,
        isSelf: Boolean(bid && ev.authorId === bid),
        isOwner: Boolean(ownerTrim && ev.authorId === ownerTrim),
      },
    },
  };
}

/**
 * Parses Discord route JSON. Entries with invalid `sessionId` (not an agent session URN) are **dropped**
 * (logged). Malformed top-level JSON still throws.
 */
export function parseDiscordRoutesWithMeta(raw: string): {
  readonly routes: DiscordSessionRoute[];
  readonly inputRowCount: number;
} {
  const j = JSON.parse(raw) as unknown;
  if (!Array.isArray(j)) {
    throw new Error("expected JSON array of route objects");
  }
  const routes: DiscordSessionRoute[] = [];
  for (let i = 0; i < j.length; i++) {
    const row = j[i];
    if (row === null || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    if (typeof o.channelId !== "string" || typeof o.sessionId !== "string") continue;
    if (!isValidAgentSessionUrn(o.sessionId)) continue;
    const parsed = parseAgentSessionUrn(o.sessionId);
    if (!parsed) continue;
    const policy = getMessagingPlatformUrnPolicy(parsed.platform);
    if (!policy) continue;
    const urnCheck = policy.checkRouteSessionUrn(parsed, o.channelId);
    if (typeof urnCheck === "object" && "fatal" in urnCheck) {
      throw new DiscordRoutesConfigurationError(urnCheck.fatal);
    }
    if (urnCheck === "drop") continue;
    const guildId =
      o.guildId === undefined || o.guildId === null ? undefined : String(o.guildId);
    routes.push({ channelId: o.channelId, sessionId: o.sessionId, guildId });
  }
  return { routes, inputRowCount: j.length };
}

export function parseDiscordRoutesJson(raw: string): DiscordSessionRoute[] {
  return parseDiscordRoutesWithMeta(raw).routes;
}

export interface DiscordMessagingDeps {
  readonly connectGateway?: typeof connectDiscordGateway;
}

/** Route guard: reserved primary UUID in session URNs must match these resolved ids. */
export interface DiscordMessagingRouteGuard {
  readonly resolvedAgentId: string;
  readonly defaultSessionPlatform: string;
  /** When set (non-empty), default-primary UUID routes are validated against `agents.list` entries. */
  readonly agentsList?: ReadonlyArray<{ readonly id: string; readonly defaultSessionPlatform?: string }>;
}

export interface StartDiscordMessagingOptions {
  readonly logger: DiscordBridgeLogger;
  readonly botToken: string | undefined;
  /** JSON array: `{ channelId, sessionId, guildId? }[]` — each `sessionId` is an `agent:` session URN */
  readonly routesJson: string | undefined;
  readonly intents?: number;
  readonly allowBotMessages?: boolean;
  /**
   * When set, routes that use the reserved default-primary session UUID must match
   * `resolvedAgentId` / `defaultSessionPlatform` (same contract as `bootstrapMainSession` in the daemon).
   */
  readonly routeGuard?: DiscordMessagingRouteGuard;
  /** Operator Discord user snowflake; marks inbound `extensions.discord.isOwner` (metadata / approver context). */
  readonly ownerUserId?: string;
  /** Gateway `MESSAGE_REACTION_ADD` (e.g. HITL notice buttons). */
  readonly onMessageReactionAdd?: (ev: DiscordReactionAddEvent) => void;
  /** Gateway `INTERACTION_CREATE` (e.g. slash commands). */
  readonly onInteractionCreate?: (ev: DiscordInteractionEvent) => void;
  /** Filled with resolved bot user id after connect (ignore reaction events from this user). */
  readonly reactionBotUserIdRef?: { current: string | undefined };
  readonly deps?: DiscordMessagingDeps;
}

export interface DiscordMessagingRuntime {
  readonly stop: () => Promise<void>;
  readonly gateway: DiscordGatewaySession;
  readonly outbound: OutboundSender;
  /** Same REST transport as outbound; use for operator-only channels (e.g. HITL alerts). */
  readonly discordRestTransport: DiscordRestTransport;
  /**
   * Best-effort Discord typing indicator for the channel mapped to `sessionId` (static route or
   * thread binding). Errors are logged at debug and ignored.
   */
  readonly notifyAgentTypingForSession: (sessionId: string) => Promise<void>;
  readonly streamingForSession: (
    sessionId: string,
  ) => ReturnType<typeof createDiscordStreamingOutbound> | undefined;
  readonly bus: AgentToAgentBus;
  readonly capabilities: MessagingAdapterCapabilities;
  /** Channel ↔ session routes from config (for inbound Discord session subscriptions). */
  readonly routes: DiscordSessionRoute[];
  /** Bot user snowflake from Gateway READY or `GET /users/@me`. */
  readonly discordBotUserId: string | undefined;
  /**
   * Bind a Discord thread (or thread channel snowflake) to a session for inbound routing and outbound delivery.
   * Returns an unregister function (idempotent).
   */
  readonly registerPlatformThreadBinding: (
    threadChannelId: string,
    sessionId: string,
  ) => () => void;
  /**
   * Channel or thread snowflake used for REST outbound for this session (routes + thread bindings).
   * Optional for test stubs; production bridge always implements this.
   */
  readonly resolveOutboundChannelIdForSession?: (sessionId: string) => string | undefined;
  /** Resolve the guild snowflake for a session (routes + thread bindings). */
  readonly resolveGuildIdForSession?: (sessionId: string) => string | undefined;
}

/**
 * When a bot token (`DISCORD_BOT_TOKEN` env, or layered `discord.token` — env wins) and
 * `SHOGGOTH_DISCORD_ROUTES` are set, connects the Gateway, maps inbound messages to sessions,
 * delivers on the agent-to-agent bus, and wires REST outbound + streaming helpers.
 */
export async function startDiscordMessagingIfConfigured(
  opts: StartDiscordMessagingOptions,
): Promise<DiscordMessagingRuntime | undefined> {
  const token = opts.botToken?.trim();
  if (!token) return undefined;

  const routesRaw = opts.routesJson?.trim();
  if (!routesRaw) {
    opts.logger.debug(
      "discord messaging: token present but SHOGGOTH_DISCORD_ROUTES unset; bridge disabled",
    );
    return undefined;
  }

  let routes: DiscordSessionRoute[];
  let inputRowCount = 0;
  try {
    const parsed = parseDiscordRoutesWithMeta(routesRaw);
    routes = parsed.routes;
    inputRowCount = parsed.inputRowCount;
  } catch (e) {
    if (e instanceof DiscordRoutesConfigurationError) {
      opts.logger.error("discord messaging: discord route configuration error", { err: String(e) });
      throw e;
    }
    opts.logger.warn("discord messaging: invalid SHOGGOTH_DISCORD_ROUTES", { err: String(e) });
    return undefined;
  }
  if (routes.length < inputRowCount) {
    opts.logger.warn("discord messaging: dropped discord routes with invalid sessionId (expected agent session URN)", {
      kept: routes.length,
      inputRows: inputRowCount,
    });
  }
  if (routes.length === 0) return undefined;

  /** Thread or thread-as-channel snowflake → subagent session id (runtime registrations). */
  const discordDynamicSessionByChannel = new Map<string, string>();
  /** Subagent session id → Discord channel id to POST messages (thread snowflake or channel id). */
  const discordOutboundChannelBySession = new Map<string, string>();

  if (opts.routeGuard) {
    try {
      const plat = opts.routeGuard.defaultSessionPlatform;
      const pol = getMessagingPlatformUrnPolicy(plat);
      if (pol) {
        pol.assertRoutesDefaultPrimaryUuidMatchesAgent(
          routes,
          opts.routeGuard.resolvedAgentId,
          plat,
          opts.routeGuard.agentsList?.length
            ? { agentsList: opts.routeGuard.agentsList }
            : undefined,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      opts.logger.error("discord messaging: route / agent id guard failed", { err: msg });
      throw e;
    }
  }

  const adapter = createDiscordAdapter({
    routes,
    resolveThreadSessionId: (channelOrThreadId) => discordDynamicSessionByChannel.get(channelOrThreadId),
  });
  const bus = createAgentToAgentBus();
  const capabilities = discordCapabilityDescriptor();
  const transport = createDiscordRestTransport({ botToken: token });

  const sessionToChannel = (sessionId: string): string | undefined =>
    discordOutboundChannelBySession.get(sessionId) ?? routes.find((r) => r.sessionId === sessionId)?.channelId;

  const sessionToGuild = (sessionId: string): string | undefined => {
    const direct = routes.find((r) => r.sessionId === sessionId);
    if (direct) return direct.guildId;
    // Dynamic thread binding: resolve the thread channel, then find the parent route's guild.
    const ch = discordOutboundChannelBySession.get(sessionId);
    if (!ch) return undefined;
    // Thread channels inherit the guild from the route whose channel spawned the thread.
    // Fall back to any route with a guildId (single-guild setups).
    return routes.find((r) => r.channelId === ch)?.guildId ?? routes.find((r) => r.guildId)?.guildId;
  };

  const outbound = createOutboundSender({ capabilities, transport, sessionToChannel });

  const streamingForSession = (sessionId: string) => {
    const channelId = sessionToChannel(sessionId);
    if (!channelId) return undefined;
    return createDiscordStreamingOutbound({ transport, capabilities, channelId });
  };

  const connect = opts.deps?.connectGateway ?? connectDiscordGateway;
  const ownerUserId = opts.ownerUserId;

  const gatewayRef: { current: DiscordGatewaySession | null } = { current: null };
  const botIdRef: { current: string | undefined } = { current: undefined };

  const onMessageCreate = (ev: DiscordInboundEvent) => {
    try {
      const bid = botIdRef.current ?? gatewayRef.current?.getBotUserId();
      if (bid && ev.authorId === bid) {
        opts.logger.debug("discord.inbound.skip_self", { messageId: ev.messageId });
        return;
      }
      const internal = adapter.inboundToInternal(ev);
      const enriched = applyDiscordTransportEnvelope(internal, ev, bid, ownerUserId);
      bus.deliver(enriched.sessionId, enriched);
      opts.logger.info("discord.inbound", {
        sessionId: enriched.sessionId,
        messageId: enriched.id,
      });
    } catch (err) {
      opts.logger.debug("discord.inbound.unrouted", { err: String(err) });
    }
  };

  const gateway = await connect({
    botToken: token,
    intents: opts.intents ?? DISCORD_GATEWAY_INTENTS_DEFAULT,
    allowBotMessages: opts.allowBotMessages,
    onMessageCreate,
    onMessageReactionAdd: opts.onMessageReactionAdd,
    onInteractionCreate: opts.onInteractionCreate,
  });
  gatewayRef.current = gateway;

  let discordBotUserId = gateway.getBotUserId()?.trim();
  if (!discordBotUserId) {
    try {
      discordBotUserId = await fetchDiscordBotUserId({ botToken: token });
      opts.logger.info("discord.bot_user.rest", { userId: discordBotUserId });
    } catch (e) {
      opts.logger.warn("discord.bot_user.unresolved", { err: String(e) });
    }
  }
  botIdRef.current = discordBotUserId;
  if (opts.reactionBotUserIdRef) {
    opts.reactionBotUserIdRef.current = discordBotUserId;
  }

  opts.logger.info("discord.messaging.ready", {
    routes: routes.length,
    platform: capabilities.platform,
    streamingOutbound: capabilities.extensions.streamingOutbound,
    botUserId: discordBotUserId ?? null,
  });

  return {
    stop: () => gateway.stop(),
    gateway,
    outbound,
    discordRestTransport: transport,
    async notifyAgentTypingForSession(sessionId) {
      const ch = sessionToChannel(sessionId.trim());
      if (!ch) return;
      try {
        await transport.triggerTypingIndicator(ch);
      } catch (e) {
        opts.logger.debug("discord.typing.notify_failed", {
          sessionId: sessionId.trim(),
          err: String(e),
        });
      }
    },
    streamingForSession,
    bus,
    capabilities,
    routes,
    discordBotUserId,
    registerPlatformThreadBinding(threadChannelId: string, sessionId: string) {
      const t = threadChannelId.trim();
      const s = sessionId.trim();
      if (!t || !s) return () => {};
      discordDynamicSessionByChannel.set(t, s);
      discordOutboundChannelBySession.set(s, t);
      return () => {
        discordOutboundChannelBySession.delete(s);
        const cur = discordDynamicSessionByChannel.get(t);
        if (cur === s) discordDynamicSessionByChannel.delete(t);
      };
    },
    resolveOutboundChannelIdForSession(sessionId: string) {
      return sessionToChannel(sessionId.trim());
    },
    resolveGuildIdForSession(sessionId: string) {
      return sessionToGuild(sessionId.trim());
    },
  };
}
