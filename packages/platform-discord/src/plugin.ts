// -------------------------------------------------------------------------------
// Discord Platform Plugin — implements MessagingPlatformPlugin

// -------------------------------------------------------------------------------

import {
  defineMessagingPlatformPlugin,
  type MessagingPlatformPlugin,
  type PlatformStartCtx,
  type PlatformDeps,
} from "@shoggoth/plugins";
import { discordPlatformRegistration } from "./platform-registration";
import { createDiscordProbe } from "./probe";
import type { DiscordMessagingRuntime } from "./bootstrap";
import type { DiscordReactionAddEvent } from "./hitl/reaction-handler";
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
import { randomUUID } from "node:crypto";

/** State held across the plugin's lifecycle. */
interface DiscordPluginState {
  messaging?: DiscordMessagingRuntime;
  platform?: DiscordPlatformHandle;
  reactionBotUserIdRef: { current: string | undefined };
  reactionPassthroughRef: { current: ((ev: DiscordReactionAddEvent) => void) | undefined };
  getToken: () => string | undefined;
}

export function createDiscordPlugin(): MessagingPlatformPlugin {
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
        const { db, config, configRef, env, deps, registerDrain, setSubagentRuntimeExtension, setMessageToolContext, setPlatformAdapter, messageToolContext } = ctx as PlatformStartCtx;
        const platformDeps = deps as PlatformDeps;

        // Set up token getter for health probe
        state.getToken = platformDeps.getBotToken;

        // Get dependencies from context
        const hitlStack = platformDeps.hitlStack;
        const hitlAutoApproveGate = platformDeps.hitlAutoApproveGate;
        // Plugin owns its own notice registry — no dependency on the daemon for this
        const hitlDiscordNoticeRegistry = hitlStack ? createHitlDiscordNoticeRegistry() : undefined;
        const logger = platformDeps.logger;
        const platformAssistantDeps = platformDeps.platformAssistantDeps;
        const abortSession = platformDeps.abortSession;
        const invokeControlOp = platformDeps.invokeControlOp;
        const resolveSessionForChannel = platformDeps.resolveSessionForChannel;
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
          noticeResolver,
          onInteractionCreate: createDiscordInteractionHandler({
            transport: new Proxy({} as DiscordMessagingRuntime["discordRestTransport"], {
              get(_t, prop, receiver) {
                if (!interactionTransportRef.current) throw new Error("discord transport not ready");
                return Reflect.get(interactionTransportRef.current, prop, receiver);
              },
            }),
            get applicationId() { return state.reactionBotUserIdRef.current ?? ""; },
            logger,
            abortSession,
            invokeControlOp,
            resolveSessionForChannel,
          }),
          onMessageReactionAdd:
            hitlStack && hitlDiscordNoticeRegistry && hitlAutoApproveGate
              ? (ev) => {
                  const consumed = handleDiscordHitlReactionAdd({
                    ev,
                    pending: hitlStack.pending,
                    registry: hitlDiscordNoticeRegistry,
                    autoApprove: hitlAutoApproveGate,
                    ownerUserId: resolveDiscordOwnerUserId(configRef.current),
                    botUserIdRef: state.reactionBotUserIdRef,
                    logger: logger.child?.("reactions") ?? logger,
                  });
                  if (!consumed) state.reactionPassthroughRef.current?.(ev);
                }
              : (ev) => { state.reactionPassthroughRef.current?.(ev); },
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
          db,
          config: configRef.current,
          configRef,
          policyEngine,
          hitlConfigRef: platformDeps.hitlConfigRef,
          hitlPending: hitlStack,
          hitlDiscordNoticeRegistry,
          hitlAutoApproveGate,
          logger,
          discord: discordMessaging,
          deps: platformAssistantDeps,
        });

        state.platform = discordPlatform;
        registerPlatformFn("discord", discordPlatform);
        setPlatformAdapter(discordPlatform.adapter);

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
        setSubagentRuntimeExtension(subagentExt);

        // Set message tool context - use provided context or build from capabilities
        if (messageToolContext) {
          setMessageToolContext(messageToolContext);
        } else {
          // Fallback: build minimal context from capabilities (for backward compatibility)
          const ctx = {
            slice: discordMessaging.capabilities.extensions,
            execute: (sessionId: string, args: any) =>
              executeMessageToolAction(
                {
                  capabilities: discordMessaging.capabilities,
                  transport: discordMessaging.discordRestTransport,
                  sessionToChannel: (sid) => discordMessaging.resolveOutboundChannelIdForSession?.(sid),
                  sessionToGuild: (sid) => discordMessaging.resolveGuildIdForSession?.(sid),
                  getSessionWorkspace: (sid) => {
                    try {
                      const row = db.prepare("SELECT workspace_path FROM sessions WHERE id = ?").get(sid) as
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
          setMessageToolContext(ctx);
        }

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
          }),
        );
      },
    },
  });
}