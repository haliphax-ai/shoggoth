import {
  connectDiscordGateway,
  createAgentToAgentBus,
  createDiscordAdapter,
  createDiscordRestTransport,
  createDiscordStreamingOutbound,
  createOutboundSender,
  discordCapabilityDescriptor,
  DISCORD_GATEWAY_INTENTS_DEFAULT,
  type AgentToAgentBus,
  type DiscordGatewaySession,
  type DiscordInboundEvent,
  type DiscordRestTransport,
  type DiscordSessionRoute,
  type MessagingAdapterCapabilities,
  type OutboundSender,
} from "@shoggoth/messaging";
import type { Logger } from "../logging";

export function parseDiscordRoutesJson(raw: string): DiscordSessionRoute[] {
  const j = JSON.parse(raw) as unknown;
  if (!Array.isArray(j)) {
    throw new Error("expected JSON array of route objects");
  }
  return j.map((row, i) => {
    if (row === null || typeof row !== "object") {
      throw new Error(`route[${i}]: expected object`);
    }
    const o = row as Record<string, unknown>;
    if (typeof o.channelId !== "string" || typeof o.sessionId !== "string") {
      throw new Error(`route[${i}]: channelId and sessionId must be strings`);
    }
    const guildId =
      o.guildId === undefined || o.guildId === null ? undefined : String(o.guildId);
    return { channelId: o.channelId, sessionId: o.sessionId, guildId };
  });
}

export interface DiscordMessagingDeps {
  readonly connectGateway?: typeof connectDiscordGateway;
}

export interface StartDiscordMessagingOptions {
  readonly logger: Logger;
  readonly botToken: string | undefined;
  /** JSON array: `{ channelId, sessionId, guildId? }[]` */
  readonly routesJson: string | undefined;
  readonly intents?: number;
  readonly allowBotMessages?: boolean;
  readonly deps?: DiscordMessagingDeps;
}

export interface DiscordMessagingRuntime {
  readonly stop: () => Promise<void>;
  readonly gateway: DiscordGatewaySession;
  readonly outbound: OutboundSender;
  /** Same REST transport as outbound; use for operator-only channels (e.g. HITL alerts). */
  readonly discordRestTransport: DiscordRestTransport;
  readonly streamingForSession: (
    sessionId: string,
  ) => ReturnType<typeof createDiscordStreamingOutbound> | undefined;
  readonly bus: AgentToAgentBus;
  readonly capabilities: MessagingAdapterCapabilities;
  /** Channel ↔ session routes from config (for inbound Discord session subscriptions). */
  readonly routes: DiscordSessionRoute[];
}

/**
 * When a bot token (`DISCORD_BOT_TOKEN` env, or layered `discord.botToken` — env wins) and
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
  try {
    routes = parseDiscordRoutesJson(routesRaw);
  } catch (e) {
    opts.logger.warn("discord messaging: invalid SHOGGOTH_DISCORD_ROUTES", { err: String(e) });
    return undefined;
  }
  if (routes.length === 0) return undefined;

  const adapter = createDiscordAdapter({ routes });
  const bus = createAgentToAgentBus();
  const capabilities = discordCapabilityDescriptor();
  const transport = createDiscordRestTransport({ botToken: token });

  const sessionToChannel = (sessionId: string): string | undefined =>
    routes.find((r) => r.sessionId === sessionId)?.channelId;

  const outbound = createOutboundSender({ capabilities, transport, sessionToChannel });

  const streamingForSession = (sessionId: string) => {
    const channelId = sessionToChannel(sessionId);
    if (!channelId) return undefined;
    return createDiscordStreamingOutbound({ transport, capabilities, channelId });
  };

  const connect = opts.deps?.connectGateway ?? connectDiscordGateway;

  const onMessageCreate = (ev: DiscordInboundEvent) => {
    try {
      const internal = adapter.inboundToInternal(ev);
      bus.deliver(internal.sessionId, internal);
      opts.logger.info("discord.inbound", {
        sessionId: internal.sessionId,
        messageId: internal.id,
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
  });

  opts.logger.info("discord.messaging.ready", {
    routes: routes.length,
    platform: capabilities.platform,
    streamingOutbound: capabilities.extensions.streamingOutbound,
  });

  return {
    stop: () => gateway.stop(),
    gateway,
    outbound,
    discordRestTransport: transport,
    streamingForSession,
    bus,
    capabilities,
    routes,
  };
}
