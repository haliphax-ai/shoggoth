// -------------------------------------------------------------------------------
// Discord Platform Plugin — implements MessagingPlatformPlugin
// -------------------------------------------------------------------------------

import {
  defineMessagingPlatformPlugin,
  type MessagingPlatformPlugin,
  type PlatformStartCtx,
  type PlatformDeps,
  type PlatformDeliveryResolver,
} from "@shoggoth/plugins";
import { discordPlatformRegistration } from "./platform-registration";
import { createDiscordProbe } from "./probe";
import type { DiscordMessagingRuntime } from "./bootstrap";
import { createHitlDiscordNoticeRegistry, type HitlDiscordNoticeRegistry } from "./hitl/notice-registry";
import type { DiscordPlatformHandle } from "./platform";
import {
  startDaemonDiscordMessaging,
  startDiscordPlatform,
  createDiscordInteractionHandler,
  handleDiscordHitlReactionAdd,
  resolveDiscordOwnerUserId,
} from "@shoggoth/platform-discord";
import { executeMessageToolAction } from "@shoggoth/messaging";
import { resolvePlatformConfig } from "@shoggoth/shared";

/** Reaction event shape (matches adapter's DiscordReactionAddEvent). */
interface ReactionAddEvent {
  userId: string;
  channelId: string;
  messageId: string;
  emoji: { name?: string; id?: string };
}

/** State held across the plugin's lifecycle. */
interface DiscordPluginState {
  messaging?: DiscordMessagingRuntime;
  platform?: DiscordPlatformHandle;
  reactionBotUserIdRef: { current: string | undefined };
  reactionPassthroughRef: { current: ((ev: ReactionAddEvent) => void) | undefined };
  getToken: () => string | undefined;
}

/** Resolve the Discord bot token from env or config. */
function resolveDiscordBotToken(config: any): string | undefined {
  const fromEnv = process.env.DISCORD_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const dc = resolvePlatformConfig(config, "discord");
  return (dc?.token as string | undefined)?.trim() || undefined;
}

/** Resolve session ID for a given channel/guild from agent routes config. */
function resolveSessionForChannel(config: any, channelId: string, guildId?: string): string | undefined {
  try {
    const agentsList = (config.agents as Record<string, unknown>)?.list as Record<string, unknown> | undefined;
    if (!agentsList) return undefined;
    for (const agentDef of Object.values(agentsList)) {
      if (typeof agentDef !== "object" || agentDef === null) continue;
      const discordPlatform = ((agentDef as Record<string, unknown>).platforms as Record<string, unknown>)?.discord as Record<string, unknown> | undefined;
      const routesList = discordPlatform?.routes;
      if (!Array.isArray(routesList)) continue;
      for (const r of routesList) {
        if (typeof r !== "object" || r === null) continue;
        const route = r as { channelId?: string; sessionId?: string; guildId?: string };
        if (route.channelId !== channelId) continue;
        if (route.guildId !== undefined && route.guildId !== guildId) continue;
        if (route.guildId === undefined && guildId !== undefined) continue;
        return route.sessionId;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discord delivery resolver — tells the daemon how to reach the operator
 * on Discord-owned sessions.
 */
function createDiscordDeliveryResolver(configRef: { current: any }): PlatformDeliveryResolver {
  return {
    resolveOperatorDelivery(_sessionId, config) {
      const ownerUserId = resolveDiscordOwnerUserId(config ?? configRef.current);
      if (ownerUserId) {
        return { kind: "messaging_surface", userId: ownerUserId };
      }
      return undefined;
    },
    resolveSessionForInbound(identifiers, config) {
      return resolveSessionForChannel(config ?? configRef.current, identifiers.channelId, identifiers.guildId);
    },
  };
}

export default function createDiscordPlugin(): MessagingPlatformPlugin {
  const state: DiscordPluginState = {
    reactionBotUserIdRef: { current: undefined },
    reactionPassthroughRef: { current: undefined },
    getToken: () => undefined,
  };

  return defineMessagingPlatformPlugin({
    name: "platform-discord",
    hooks: {
      "platform.register"(ctx) {
        // Register the Discord platform URN policy
        ctx.registerPlatform(discordPlatformRegistration);
      },

      async "platform.start"(ctx) {
        const { db, config, configRef, env, deps, deliveryRegistry, registerDrain, setSubagentRuntimeExtension, setMessageToolContext, setPlatformAdapter } = ctx as PlatformStartCtx;
        const platformDeps = deps as PlatformDeps;

        // Plugin reads its own bot token from config
        state.getToken = () => resolveDiscordBotToken(configRef.current);

        // Register delivery resolver for the "discord" platform segment
        deliveryRegistry.register("discord", createDiscordDeliveryResolver(configRef));

        // Get dependencies from context
        const hitlStack = platformDeps.hitlStack;
        const hitlAutoApproveGate = platformDeps.hitlAutoApproveGate;
        // Plugin owns its own notice registry
        const hitlDiscordNoticeRegistry = hitlStack ? createHitlDiscordNoticeRegistry() : undefined;
        const logger = platformDeps.logger;
        const platformAssistantDeps = platformDeps.platformAssistantDeps;
        const abortSession = platformDeps.abortSession;
        const invokeControlOp = platformDeps.invokeControlOp;
        const registerPlatformFn = platformDeps.registerPlatform;
        const stopAllPlatforms = platformDeps.stopAllPlatforms;
        const reconcilePersistentSubagents = platformDeps.reconcilePersistentSubagents;
        const noticeResolver = platformDeps.noticeResolver;

        // Create interaction transport ref for the interaction handler
        const interactionTransportRef: { current: DiscordMessagingRuntime["discordRestTransport"] | undefined } = { current: undefined };

        // Start Discord messaging (gateway)
        const discordMessaging = await startDaemonDiscordMessaging({
          logger,
          config: configRef.current,
          botToken: state.getToken(),
          noticeResolver: noticeResolver as any,
          onInteractionCreate: createDiscordInteractionHandler({
            transport: new Proxy({} as DiscordMessagingRuntime["discordRestTransport"], {
              get(_t, prop, receiver) {
                if (!interactionTransportRef.current) throw new Error("discord transport not ready");
                return Reflect.get(interactionTransportRef.current, prop, receiver);
              },
            }),
            get applicationId() { return state.reactionBotUserIdRef.current ?? ""; },
            logger,
            abortSession: abortSession as any,
            invokeControlOp,
            resolveSessionForChannel: (channelId, guildId) =>
              resolveSessionForChannel(configRef.current, channelId, guildId),
          }),
          onMessageReactionAdd:
            hitlStack && hitlDiscordNoticeRegistry && hitlAutoApproveGate
              ? (ev: any) => {
                  const consumed = handleDiscordHitlReactionAdd({
                    ev,
                    pending: hitlStack.pending as any,
                    registry: hitlDiscordNoticeRegistry,
                    autoApprove: hitlAutoApproveGate as any,
                    ownerUserId: resolveDiscordOwnerUserId(configRef.current),
                    botUserIdRef: state.reactionBotUserIdRef,
                    logger: (logger.child as any)?.("reactions") ?? logger,
                  });
                  if (!consumed) state.reactionPassthroughRef.current?.(ev);
                }
              : (ev: any) => { state.reactionPassthroughRef.current?.(ev); },
          reactionBotUserIdRef: state.reactionBotUserIdRef,
        });

        if (discordMessaging) {
          state.messaging = discordMessaging;
          interactionTransportRef.current = discordMessaging.discordRestTransport;
          registerDrain("discord-messaging", () => discordMessaging.stop());
        }

        if (!discordMessaging || !db) {
          logger.warn("discord messaging failed to start or no database");
          return;
        }

        // Get policy engine from deps
        const policyEngine = platformDeps.policyEngine;

        // Start Discord platform (sessions, HITL, MCP, orchestrator)
        const discordPlatform = await startDiscordPlatform({
          db: db as any,
          config: configRef.current,
          configRef,
          policyEngine: policyEngine as any,
          hitlConfigRef: platformDeps.hitlConfigRef as any,
          hitlPending: hitlStack as any,
          hitlDiscordNoticeRegistry,
          hitlAutoApproveGate: hitlAutoApproveGate as any,
          logger,
          discord: discordMessaging,
          deps: platformAssistantDeps as any,
        });

        state.platform = discordPlatform;
        registerPlatformFn("discord", discordPlatform);
        setPlatformAdapter(discordPlatform.adapter as any);

        // Wire reaction passthrough
        state.reactionPassthroughRef.current = (ev) => {
          const botId = state.reactionBotUserIdRef.current;
          if (botId && ev.userId === botId) return;
          const owner = resolveDiscordOwnerUserId(configRef.current)?.trim();
          if (!owner || ev.userId !== owner) return;

          const sessionId = discordMessaging.resolveOutboundChannelIdForSession
            ? (() => {
                for (const r of discordMessaging.routes) {
                  if (r.channelId === ev.channelId) return r.sessionId;
                }
                return undefined;
              })()
            : undefined;

          if (!sessionId) {
            logger.debug("reaction.passthrough.no_session", { channelId: ev.channelId });
            return;
          }

          const emojiStr = ev.emoji.id ? `<:${ev.emoji.name ?? "_"}:${ev.emoji.id}>` : (ev.emoji.name ?? "");
          if (!emojiStr) return;

          void (async () => {
            try {
              const msg = await discordMessaging.discordRestTransport.getMessage(ev.channelId, ev.messageId);
              const authorId = (msg.author as Record<string, unknown> | undefined)?.id;
              if (typeof authorId !== "string" || authorId !== botId) {
                logger.debug("reaction.passthrough.not_bot_message", { messageId: ev.messageId });
                return;
              }
              const content = typeof msg.content === "string" ? msg.content : "";
              const timestamp = typeof msg.timestamp === "string" ? new Date(msg.timestamp).getTime() : Date.now();
              await discordPlatform.handleReactionPassthrough({
                sessionId,
                messageContent: content,
                messageTimestamp: timestamp,
                emoji: emojiStr,
                userId: ev.userId,
              });
            } catch (e) {
              logger.warn("reaction.passthrough.fetch_failed", { err: String(e), messageId: ev.messageId });
            }
          })();
        };

        // Set subagent runtime extension
        const subagentExt = {
          runSessionModelTurn: discordPlatform.runSessionModelTurn,
          subscribeSubagentSession: discordPlatform.subscribeSubagentSession,
          registerPlatformThreadBinding: discordMessaging.registerPlatformThreadBinding,
          announcePersistentSubagentSessionEnded: discordPlatform.announcePersistentSubagentSessionEnded,
        };
        setSubagentRuntimeExtension(subagentExt as any);

        // Build message tool context from capabilities
        const msgCtx = {
          slice: discordMessaging.capabilities.extensions as unknown as Record<string, boolean>,
          execute: (sessionId: string, args: any) =>
            executeMessageToolAction(
              {
                capabilities: discordMessaging.capabilities,
                transport: discordMessaging.discordRestTransport,
                sessionToChannel: (sid) => discordMessaging.resolveOutboundChannelIdForSession?.(sid),
                sessionToGuild: (sid) => discordMessaging.resolveGuildIdForSession?.(sid),
                getSessionWorkspace: (sid) => {
                  try {
                    const row = (db as any).prepare("SELECT workspace_path FROM sessions WHERE id = ?").get(sid) as
                      | { workspace_path: string }
                      | undefined;
                    return row?.workspace_path;
                  } catch {
                    return undefined;
                  }
                },
                downloadFile: async (url, destPath) => {
                  const res = await fetch(url);
                  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
                  const buf = Buffer.from(await res.arrayBuffer());
                  const { writeFile, mkdir } = await import("node:fs/promises");
                  const { dirname } = await import("node:path");
                  await mkdir(dirname(destPath), { recursive: true });
                  await writeFile(destPath, buf);
                  return buf.byteLength;
                },
              },
              sessionId,
              args,
            ),
        };
        setMessageToolContext(msgCtx);

        // Run persistent subagent reconciliation
        const subRecon = reconcilePersistentSubagents({
          db,
          config: configRef.current,
          ext: subagentExt,
        });
        if (subRecon.restored > 0 || subRecon.expiredKilled > 0) {
          logger.info("subagent.persisted_reconciled", {
            restored: subRecon.restored,
            expired_killed: subRecon.expiredKilled,
          });
        }

        // Register shutdown drain for platforms
        registerDrain("platforms", async () => {
          await stopAllPlatforms();
          setSubagentRuntimeExtension(undefined);
        });
      },

      async "platform.stop"(_ctx) {
        if (state.platform) {
          await state.platform.stop();
          state.platform = undefined;
        }
        if (state.messaging) {
          await state.messaging.stop();
          state.messaging = undefined;
        }
        state.reactionPassthroughRef.current = undefined;
      },

      "health.register"(ctx) {
        ctx.registerProbe(
          createDiscordProbe({
            getToken: state.getToken,
          }) as any,
        );
      },
    },
  });
}
