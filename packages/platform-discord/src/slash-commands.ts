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

export interface DiscordInteractionHandlerDeps {
  readonly transport: DiscordRestTransport;
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
            const inTok = (stats.inputTokens as number) ?? 0;
            const outTok = (stats.outputTokens as number) ?? 0;
            const totalTok = inTok + outTok;
            const ctxWin = stats.contextWindowTokens as number | null;
            const tokLine = ctxWin
              ? `Tokens: ${totalTok.toLocaleString("en-US")} / ${ctxWin.toLocaleString("en-US")} (${((totalTok / ctxWin) * 100).toFixed(1)}%) — ${inTok.toLocaleString("en-US")} in / ${outTok.toLocaleString("en-US")} out`
              : `Tokens: ${inTok.toLocaleString("en-US")} in / ${outTok.toLocaleString("en-US")} out`;
            lines.push(
              ``,
              `📊 **Stats**`,
              `Turns: ${stats.turnCount ?? 0}`,
              tokLine,
              `Messages: ${stats.transcriptMessageCount ?? 0}`,
              `Compactions: ${stats.compactionCount ?? 0}`,
            );
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

  await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: { content: `Unhandled operation: \`${controlOp.op}\`` },
  });
}
