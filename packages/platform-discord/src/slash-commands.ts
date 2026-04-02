/**
 * Discord slash command registration and interaction handling.
 */

import type { DiscordRestTransport } from "./transport";
import type { DiscordInteractionEvent } from "./interaction";
import { discordInteractionToCommand } from "./interaction";
import { translateCommandToControlOp } from "@shoggoth/daemon/lib";

/** The set of global slash commands to register. */
const GLOBAL_SLASH_COMMANDS = [
  {
    name: "abort",
    description: "Abort the current session turn",
    options: [
      {
        name: "session_id",
        type: 3, // STRING
        description: "Session URN to abort",
        required: false,
      },
    ],
  },
  {
    name: "new",
    description: "Start a new session context (preserves history)",
    options: [
      { name: "session_id", type: 3, description: "Session URN", required: false },
    ],
  },
  {
    name: "reset",
    description: "Reset session context (clears transcript)",
    options: [
      { name: "session_id", type: 3, description: "Session URN", required: false },
    ],
  },
  {
    name: "compact",
    description: "Compact session transcript (summarize old messages)",
    options: [
      { name: "session_id", type: 3, description: "Session URN", required: false },
      { name: "force", type: 5, description: "Force compaction even if under threshold", required: false },
    ],
  },
  {
    name: "status",
    description: "Show current session status (provider, model, tokens, turns, compactions)",
    options: [
      { name: "session_id", type: 3, description: "Session URN", required: false },
    ],
  },
  {
    name: "queue",
    description: "Manage the session turn queue",
    options: [
      { name: "action", type: 3, description: "list, remove, or clear", required: true },
      { name: "priority", type: 3, description: "system, user, or all", required: false },
      { name: "index", type: 4, description: "Index to remove", required: false },
      { name: "range", type: 3, description: "Range to remove (e.g. 0-4)", required: false },
      { name: "count", type: 4, description: "Remove first N entries", required: false },
      { name: "session_id", type: 3, description: "Session URN", required: false },
    ],
  },
] as const;

/**
 * Register global slash commands with Discord. The application ID equals the bot user ID
 * for bot applications.
 */
export async function registerDiscordSlashCommands(opts: {
  readonly transport: DiscordRestTransport;
  readonly applicationId: string;
}): Promise<void> {
  await opts.transport.registerGlobalCommands(
    opts.applicationId,
    GLOBAL_SLASH_COMMANDS as unknown as Record<string, unknown>[],
  );
}

/** Interaction response type 4 = CHANNEL_MESSAGE_WITH_SOURCE. */
const INTERACTION_RESPONSE_CHANNEL_MESSAGE = 4;
/** Interaction response type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE. */
const INTERACTION_RESPONSE_DEFERRED = 5;

export interface DiscordInteractionHandlerDeps {
  readonly transport: DiscordRestTransport;
  readonly applicationId: string;
  readonly logger: {
    readonly info: (msg: string, fields?: Record<string, unknown>) => void;
    readonly warn: (msg: string, fields?: Record<string, unknown>) => void;
    readonly debug: (msg: string, fields?: Record<string, unknown>) => void;
  };
  /**
   * Execute a session abort. Returns true if the abort was initiated.
   * When `sessionId` is undefined, abort the "current" or default session.
   */
  readonly abortSession: (sessionId: string | undefined) => Promise<boolean>;
  readonly invokeControlOp: (op: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** Resolve the session URN for a given channel + guild. Returns undefined if no route exists. */
  readonly resolveSessionForChannel?: (channelId: string, guildId?: string) => string | undefined;
}

/**
 * Creates a callback suitable for the gateway's `onInteractionCreate` option.
 * Parses the interaction into a PlatformCommand, translates to a control op,
 * executes it, and sends an interaction response back to Discord.
 */
export function createDiscordInteractionHandler(
  deps: DiscordInteractionHandlerDeps,
): (ev: DiscordInteractionEvent) => void {
  return (ev: DiscordInteractionEvent) => {
    void handleInteraction(deps, ev).catch((err) => {
      deps.logger.warn("discord.interaction.handler_error", { err: String(err) });
    });
  };
}

async function handleInteraction(
  deps: DiscordInteractionHandlerDeps,
  ev: DiscordInteractionEvent,
): Promise<void> {
  const parsed = discordInteractionToCommand(ev);
  if (!parsed) {
    deps.logger.debug("discord.interaction.ignored", { type: ev.type, id: ev.id });
    return;
  }

  const controlOp = translateCommandToControlOp(parsed.command);
  if (!controlOp) {
    await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: { content: `Unknown command: \`${parsed.command.name}\`` },
    });
    return;
  }

  deps.logger.info("discord.interaction.command", {
    command: parsed.command.name,
    op: controlOp.op,
    interactionId: parsed.interactionId,
  });

  if (controlOp.op === "session_abort") {
    let sessionId = (controlOp.payload.session_id as string | undefined) ?? undefined;
    if (!sessionId && deps.resolveSessionForChannel) {
      const resolved = deps.resolveSessionForChannel(parsed.channelId, parsed.guildId);
      if (resolved) sessionId = resolved;
    }
    let aborted: boolean;
    try {
      aborted = await deps.abortSession(sessionId);
    } catch (err) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: `⚠️ Abort failed: ${String(err)}` },
      });
      return;
    }

    const content = aborted
      ? "✅ Session abort initiated."
      : "⚠️ No active session turn to abort.";
    await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: { content },
    });
    return;
  }

  if (controlOp.op === "session_context_status") {
    try {
      // Resolve session_id from channel if not explicitly provided
      const payload = { ...controlOp.payload };
      if (!payload.session_id && deps.resolveSessionForChannel) {
        const resolved = deps.resolveSessionForChannel(parsed.channelId, parsed.guildId);
        if (resolved) payload.session_id = resolved;
      }
      if (!payload.session_id) {
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: { content: "⚠️ No session bound to this channel. Provide a session_id." },
        });
        return;
      }
      const res = await deps.invokeControlOp(controlOp.op, payload);
      let content: string;
      if (res.ok && res.result) {
        const r = res.result as Record<string, unknown>;
        if (r.session === null) {
          content = "Session not found.";
        } else {
          const session = r.session as Record<string, unknown>;
          const stats = r.stats as Record<string, unknown> | null;
          const model = r.model as Record<string, unknown> | null;
          const lines: (string | null)[] = [
            `📋 **Session Status**`,
            `ID: \`${session.id}\``,
            `Status: ${session.status}`,
            model?.providerId ? `Provider: ${model.providerId}` : null,
            model?.model ? `Model: ${model.model}` : null,
            `Context segment: \`${session.contextSegmentId}\``,
          ];
          if (stats) {
            const fmt = r.formattedStats as { contextFill: string; contextWindowSuffix: string; turns: number; compactions: number; messages: number } | null;
            const contextLine = fmt
              ? `Context: ${fmt.contextFill}${fmt.contextWindowSuffix}`
              : `Turns: ${stats.turnCount ?? 0}`;
            lines.push(
              ``,
              `📊 **Stats**`,
              contextLine,
              fmt ? `Turns: ${fmt.turns}` : null,
              `Messages: ${(fmt?.messages ?? stats.transcriptMessageCount) ?? 0}`,
              `Compactions: ${(fmt?.compactions ?? stats.compactionCount) ?? 0}`,
            );
          }
          const qd = r.queueDepth as { system: number; user: number } | null;
          if (qd) {
            lines.push(`Queue: ${qd.system} system / ${qd.user} user`);
          }
          content = lines.filter(Boolean).join("\n");
        }
      } else {
        content = `⚠️ Failed to get status: ${res.error ?? "unknown error"}`;
      }
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content },
      });
    } catch (err) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: `⚠️ Status failed: ${String(err)}` },
      });
    }
    return;
  }

  if (controlOp.op === "session_context_new" || controlOp.op === "session_context_reset" || controlOp.op === "session_compact") {
    const isCompact = controlOp.op === "session_compact";
    try {
      // Resolve session_id from channel if not explicitly provided
      const payload = { ...controlOp.payload };
      if (!payload.session_id && deps.resolveSessionForChannel) {
        const resolved = deps.resolveSessionForChannel(parsed.channelId, parsed.guildId);
        if (resolved) payload.session_id = resolved;
      }
      if (!payload.session_id) {
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: { content: "⚠️ No session bound to this channel. Provide a session_id." },
        });
        return;
      }

      // Compact can take a long time (model summarization call) — defer the response.
      if (isCompact) {
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_DEFERRED,
        });
        try {
          const res = await deps.invokeControlOp(controlOp.op, payload);
          const content = res.ok
            ? `✅ \`${controlOp.op}\` completed.`
            : `⚠️ \`${controlOp.op}\` failed: ${res.error ?? "unknown error"}`;
          await deps.transport.editOriginalInteractionResponse(deps.applicationId, parsed.interactionToken, { content });
        } catch (err) {
          await deps.transport.editOriginalInteractionResponse(deps.applicationId, parsed.interactionToken, {
            content: `⚠️ \`${controlOp.op}\` failed: ${String(err)}`,
          });
        }
        return;
      }

      const res = await deps.invokeControlOp(controlOp.op, payload);
      const content = res.ok
        ? `✅ \`${controlOp.op}\` completed.`
        : `⚠️ \`${controlOp.op}\` failed: ${res.error ?? "unknown error"}`;
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content },
      });
    } catch (err) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: `⚠️ \`${controlOp.op}\` failed: ${String(err)}` },
      });
    }
    return;
  }

  if (controlOp.op === "session_queue_manage") {
    try {
      const payload = { ...controlOp.payload };
      if (!payload.session_id && deps.resolveSessionForChannel) {
        const resolved = deps.resolveSessionForChannel(parsed.channelId, parsed.guildId);
        if (resolved) payload.session_id = resolved;
      }
      if (!payload.session_id) {
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: { content: "⚠️ No session bound to this channel. Provide a session_id." },
        });
        return;
      }
      const res = await deps.invokeControlOp(controlOp.op, payload);
      let content: string;
      if (!res.ok) {
        content = `⚠️ Queue operation failed: ${res.error ?? "unknown error"}`;
      } else {
        const r = res.result as Record<string, unknown>;
        if (r.entries !== undefined) {
          const entries = r.entries as Array<{ index: number; priority: string; label: string; enqueuedAt: number }>;
          if (entries.length === 0) {
            content = "Queue is empty.";
          } else {
            const lines = entries.map((e) => `${e.index}. [${e.priority}] ${e.label}`);
            content = `📋 **Queue** (${entries.length} entries)\n${lines.join("\n")}`;
          }
        } else {
          content = `✅ Removed ${r.removed ?? 0} entries.`;
        }
      }
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content },
      });
    } catch (err) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: `⚠️ Queue failed: ${String(err)}` },
      });
    }
    return;
  }

  await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: { content: `Unhandled operation: \`${controlOp.op}\`` },
  });
}
