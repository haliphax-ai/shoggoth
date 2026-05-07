/**
 * Discord slash command registration and interaction handling.
 */

import type { DiscordRestTransport } from "./transport";
import type { DiscordInteractionEvent } from "./interaction";
import { discordInteractionToCommand } from "./interaction";
import { translateCommandToControlOp } from "@shoggoth/daemon/lib";
import {
  buildProviderSelectOptions,
  buildModelSelectOptions,
  encodeModelSelectCustomId,
  decodeModelSelectCustomId,
} from "./model-select";

/** The set of global slash commands to register. */
const GLOBAL_SLASH_COMMANDS = [
  {
    name: "elevate",
    description: "Grant or revoke elevated privileges for a session",
    options: [
      {
        name: "action",
        type: 3, // STRING
        description: "grant or revoke (default: grant)",
        required: false,
        choices: [
          { name: "grant", value: "grant" },
          { name: "revoke", value: "revoke" },
        ],
      },
      {
        name: "session_id",
        type: 3,
        description: "Session URN (defaults to this channel's session)",
        required: false,
      },
      {
        name: "duration",
        type: 3,
        description: "Grant duration e.g. 5m, 30m (default: 5m)",
        required: false,
      },
      {
        name: "grant_id",
        type: 3,
        description: "Specific grant ID to revoke",
        required: false,
      },
    ],
  },
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
      {
        name: "session_id",
        type: 3,
        description: "Session URN",
        required: false,
      },
    ],
  },
  {
    name: "reset",
    description: "Reset session context (clears transcript)",
    options: [
      {
        name: "session_id",
        type: 3,
        description: "Session URN",
        required: false,
      },
    ],
  },
  {
    name: "compact",
    description: "Compact session transcript (summarize old messages)",
    options: [
      {
        name: "session_id",
        type: 3,
        description: "Session URN",
        required: false,
      },
    ],
  },
  {
    name: "status",
    description: "Show current session status (provider, model, tokens, turns, compactions)",
    options: [
      {
        name: "session_id",
        type: 3,
        description: "Session URN",
        required: false,
      },
    ],
  },
  {
    name: "model",
    description: "Get or set the session model selection",
    options: [
      {
        name: "session_id",
        type: 3,
        description: "Session URN",
        required: false,
      },
      {
        name: "agent_id",
        type: 3,
        description: "Agent ID (alternative to session_id)",
        required: false,
      },
    ],
  },
  {
    name: "queue",
    description: "Manage the session turn queue",
    options: [
      {
        name: "action",
        type: 3,
        description: "list, remove, or clear",
        required: true,
      },
      {
        name: "priority",
        type: 3,
        description: "system, user, or all",
        required: false,
      },
      {
        name: "index",
        type: 4,
        description: "Index to remove",
        required: false,
      },
      {
        name: "range",
        type: 3,
        description: "Range to remove (e.g. 0-4)",
        required: false,
      },
      {
        name: "count",
        type: 4,
        description: "Remove first N entries",
        required: false,
      },
      {
        name: "session_id",
        type: 3,
        description: "Session URN",
        required: false,
      },
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
/** Interaction response type 7 = UPDATE_MESSAGE. */
const INTERACTION_RESPONSE_UPDATE_MESSAGE = 7;
/** Interaction response type 9 = MODAL. */
const INTERACTION_RESPONSE_MODAL = 9;
/** Component type 1 = ACTION_ROW. */
const ACTION_ROW = 1;
/** Component type 3 = STRING_SELECT. */
const STRING_SELECT = 3;
/** Component type 4 = TEXT_INPUT. */
const TEXT_INPUT = 4;
/** Text input style 1 = SHORT. */
const TEXT_INPUT_SHORT = 1;

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
  readonly invokeControlOp: (
    op: string,
    payload: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** Resolve the session URN for a given channel + guild. Returns undefined if no route exists. */
  readonly resolveSessionForChannel?: (channelId: string, guildId?: string) => string | undefined;
  /** Get the models configuration for building provider select menus. */
  readonly getModelsConfig?: () => Promise<{
    providers: ReadonlyArray<{
      id: string;
      name: string;
      models?: ReadonlyArray<{ name: string }>;
    }>;
    failoverChain?: ReadonlyArray<{ providerId: string; model: string }>;
  } | null>;
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
      deps.logger.warn("discord.interaction.handler_error", {
        err: String(err),
      });
    });
  };
}

async function handleInteraction(
  deps: DiscordInteractionHandlerDeps,
  ev: DiscordInteractionEvent,
): Promise<void> {
  // Handle component interactions (type 3) and modal submits (type 5)
  if (ev.type === 3) {
    // MESSAGE_COMPONENT interaction
    const customId = ev.data?.custom_id;
    if (!customId) {
      deps.logger.debug("discord.interaction.ignored", {
        type: ev.type,
        id: ev.id,
      });
      return;
    }

    const decoded = decodeModelSelectCustomId(customId);
    if (!decoded) {
      // Unknown component - ignore
      deps.logger.debug("discord.interaction.ignored", {
        type: ev.type,
        id: ev.id,
        customId,
      });
      return;
    }

    const { step, sessionId, extra } = decoded;

    if (step === "provider") {
      const values = ev.data?.values;
      if (!values || values.length === 0) {
        return;
      }
      const value = values[0];

      if (value === "__custom__") {
        // Respond with modal for custom input
        await deps.transport.interactionCallback(ev.id, ev.token, {
          type: INTERACTION_RESPONSE_MODAL,
          data: {
            title: "Enter Model",
            custom_id: encodeModelSelectCustomId("custom_modal", sessionId),
            components: [
              {
                type: ACTION_ROW,
                components: [
                  {
                    type: TEXT_INPUT,
                    custom_id: "model_input",
                    label: "Model (provider/model)",
                    style: TEXT_INPUT_SHORT,
                    required: true,
                    placeholder: "e.g., openai/gpt-4",
                  },
                ],
              },
            ],
          },
        });
        return;
      }

      // Real provider selected - show model select
      if (!deps.getModelsConfig) {
        // Shouldn't happen if we got here, but handle gracefully
        return;
      }

      const modelsConfig = await deps.getModelsConfig();
      if (!modelsConfig || !modelsConfig.providers) {
        return;
      }

      const provider = modelsConfig.providers.find((p) => p.id === value);
      if (!provider) {
        return;
      }

      // Build model options
      const modelOptions = buildModelSelectOptions({
        providerId: value,
        providers: modelsConfig.providers.map((p) => ({
          id: p.id,
          name: p.name,
          models: p.models?.map((m) => ({ id: m.name, name: m.name })) || [],
        })),
        failoverChain: (modelsConfig.failoverChain || []).map((e) => ({
          providerId: e.providerId,
          modelId: e.model,
        })),
      });

      // Rebuild provider options with the newly selected provider highlighted
      const providerOptions = buildProviderSelectOptions({
        providers: modelsConfig.providers.map((p) => ({
          id: p.id,
          name: p.name,
          models: p.models?.map((m) => ({ id: m.name, name: m.name })) || [],
        })),
        currentProviderId: value,
      });

      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
        data: {
          content: `🎯 **Model Configuration**\nSession: \`${sessionId}\`\nProvider: ${provider.name}`,
          components: [
            {
              type: ACTION_ROW,
              components: [
                {
                  type: STRING_SELECT,
                  custom_id: encodeModelSelectCustomId("provider", sessionId),
                  placeholder: "Select a provider",
                  options: providerOptions,
                },
              ],
            },
            {
              type: ACTION_ROW,
              components: [
                {
                  type: STRING_SELECT,
                  custom_id: encodeModelSelectCustomId("model", sessionId, value),
                  placeholder: "Select a model",
                  options: modelOptions,
                },
              ],
            },
          ],
        },
      });
      return;
    }

    if (step === "model") {
      const values = ev.data?.values;
      if (!values || values.length === 0) {
        return;
      }
      const selectedModel = values[0];
      const providerId = extra;

      if (!providerId) {
        return;
      }

      const modelSelection = { model: `${providerId}/${selectedModel}` };

      try {
        const res = await deps.invokeControlOp("session_model", {
          session_id: sessionId,
          model_selection: modelSelection,
        });

        const content = res.ok
          ? `✅ Model set to \`${providerId}/${selectedModel}\``
          : `⚠️ Failed to set model: ${res.error ?? "unknown error"}`;

        await deps.transport.interactionCallback(ev.id, ev.token, {
          type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
          data: {
            content,
            components: [],
          },
        });
      } catch (err) {
        await deps.transport.interactionCallback(ev.id, ev.token, {
          type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
          data: {
            content: `⚠️ Failed to set model: ${String(err)}`,
            components: [],
          },
        });
      }
      return;
    }

    // Unknown step - ignore
    return;
  }

  if (ev.type === 5) {
    // MODAL_SUBMIT interaction
    const customId = ev.data?.custom_id;
    if (!customId) {
      deps.logger.debug("discord.interaction.ignored", {
        type: ev.type,
        id: ev.id,
      });
      return;
    }

    const decoded = decodeModelSelectCustomId(customId);
    if (!decoded) {
      // Unknown modal - ignore
      deps.logger.debug("discord.interaction.ignored", {
        type: ev.type,
        id: ev.id,
        customId,
      });
      return;
    }

    if (decoded.step !== "custom_modal") {
      return;
    }

    // Extract text input value
    const components = ev.data?.components;
    if (!components || components.length === 0) {
      return;
    }

    const textInput = components[0]?.components?.[0];
    if (!textInput || !textInput.value) {
      return;
    }

    const value = textInput.value;

    // Validate it contains '/'
    if (!value.includes("/")) {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
        data: {
          content: `⚠️ Invalid model format. Expected \`provider/model\`, got \`${value}\``,
          components: [],
        },
      });
      return;
    }

    try {
      const res = await deps.invokeControlOp("session_model", {
        session_id: decoded.sessionId,
        model_selection: { model: value },
      });

      const content = res.ok
        ? `✅ Model set to \`${value}\``
        : `⚠️ Failed to set model: ${res.error ?? "unknown error"}`;

      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
        data: {
          content,
          components: [],
        },
      });
    } catch (err) {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
        data: {
          content: `⚠️ Failed to set model: ${String(err)}`,
          components: [],
        },
      });
    }
    return;
  }

  const parsed = discordInteractionToCommand(ev);
  if (!parsed) {
    deps.logger.debug("discord.interaction.ignored", {
      type: ev.type,
      id: ev.id,
    });
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

    const content = aborted ? "✅ Session abort initiated." : "⚠️ No active session turn to abort.";
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
          data: {
            content: "⚠️ No session bound to this channel. Provide a session_id.",
          },
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
            model?.model ? `Model: ${model.model}` : null,
            `Context segment: \`${session.contextSegmentId}\``,
          ];
          if (stats) {
            const fmt = r.formattedStats as {
              contextFill: string;
              contextWindowSuffix: string;
              turns: number;
              compactions: number;
              messages: number;
            } | null;
            const contextLine = fmt
              ? `Context: ${fmt.contextFill}${fmt.contextWindowSuffix}`
              : `Turns: ${stats.turnCount ?? 0}`;
            lines.push(
              ``,
              `📊 **Stats**`,
              contextLine,
              fmt ? `Turns: ${fmt.turns}` : null,
              `Messages: ${fmt?.messages ?? stats.transcriptMessageCount ?? 0}`,
              `Compactions: ${fmt?.compactions ?? stats.compactionCount ?? 0}`,
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

  if (controlOp.op === "session_model") {
    try {
      const payload = { ...controlOp.payload };
      if (!payload.session_id && deps.resolveSessionForChannel) {
        const resolved = deps.resolveSessionForChannel(parsed.channelId, parsed.guildId);
        if (resolved) payload.session_id = resolved;
      }
      if (!payload.session_id) {
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: {
            content: "⚠️ No session bound to this channel. Provide a session_id or agent_id.",
          },
        });
        return;
      }

      // Get current model (read-only, no model_selection in payload)
      const currentModelRes = await deps.invokeControlOp(controlOp.op, {
        session_id: payload.session_id,
      });

      // Extract current provider/model for defaults
      let currentProviderId: string | undefined;
      let currentModel: string | undefined;

      if (currentModelRes.ok && currentModelRes.result) {
        const r = currentModelRes.result as Record<string, unknown>;
        // Check explicit model_selection override first
        const modelSel = r.model_selection as Record<string, unknown> | null | undefined;
        if (modelSel && typeof modelSel.model === "string") {
          const m = modelSel.model as string;
          const slashIdx = m.indexOf("/");
          if (slashIdx > 0) {
            currentProviderId = m.slice(0, slashIdx);
            currentModel = m.slice(slashIdx + 1);
          }
        }
        // Fall back to first failoverChain entry from effective config
        if (!currentProviderId || !currentModel) {
          const effectiveModels = r.effective_models as Record<string, unknown> | null;
          if (effectiveModels) {
            const chain = effectiveModels.failoverChain as string[] | undefined;
            if (chain && chain.length > 0) {
              const first = chain[0];
              const slashIdx = first.indexOf("/");
              if (slashIdx > 0) {
                currentProviderId = first.slice(0, slashIdx);
                currentModel = first.slice(slashIdx + 1);
              }
            }
          }
        }
      }

      // Get models configuration
      const modelsConfig = deps.getModelsConfig ? await deps.getModelsConfig() : null;

      if (!modelsConfig || !modelsConfig.providers || modelsConfig.providers.length === 0) {
        // No providers available - respond with modal for free-text input
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_MODAL,
          data: {
            title: "Enter Model",
            custom_id: encodeModelSelectCustomId("custom_modal", payload.session_id as string),
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4, // TEXT_INPUT
                    custom_id: "model_input",
                    label: "Model (provider/model)",
                    style: 1, // SHORT
                    required: true,
                    placeholder: "e.g., openai/gpt-4",
                  },
                ],
              },
            ],
          },
        });
        return;
      }

      // Build provider select options
      const providerOptions = buildProviderSelectOptions({
        providers: modelsConfig.providers.map((p) => ({
          id: p.id,
          name: p.name,
          models: p.models?.map((m) => ({ id: m.name, name: m.name })) || [],
        })),
        currentProviderId,
      });

      // Build current model display
      const currentModelDisplay =
        currentProviderId && currentModel ? `\`${currentProviderId}/${currentModel}\`` : "Not set";

      // Respond with both provider and model select menus
      // Determine which provider to show models for (current or first available)
      const activeProviderId = currentProviderId || modelsConfig.providers[0]?.id;
      const modelOptions = activeProviderId
        ? buildModelSelectOptions({
            providerId: activeProviderId,
            providers: modelsConfig.providers.map((p) => ({
              id: p.id,
              name: p.name,
              models: p.models?.map((m) => ({ id: m.name, name: m.name })) || [],
            })),
            failoverChain: (modelsConfig.failoverChain || []).map((e) => ({
              providerId: e.providerId,
              modelId: e.model,
            })),
          })
        : [];

      const components: Record<string, unknown>[] = [
        {
          type: 1,
          components: [
            {
              type: 3, // STRING_SELECT
              custom_id: encodeModelSelectCustomId("provider", payload.session_id as string),
              placeholder: "Select a provider",
              options: providerOptions,
            },
          ],
        },
      ];

      if (modelOptions.length > 0) {
        components.push({
          type: 1,
          components: [
            {
              type: 3, // STRING_SELECT
              custom_id: encodeModelSelectCustomId(
                "model",
                payload.session_id as string,
                activeProviderId,
              ),
              placeholder: "Select a model",
              options: modelOptions,
            },
          ],
        });
      }

      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: {
          content: `🎯 **Model Configuration**\nSession: \`${payload.session_id}\`\nCurrent: ${currentModelDisplay}`,
          flags: 64, // Ephemeral
          components,
        },
      });
    } catch (err) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: `⚠️ Model command failed: ${String(err)}` },
      });
    }
    return;
  }

  if (
    controlOp.op === "session_context_new" ||
    controlOp.op === "session_context_reset" ||
    controlOp.op === "session_compact"
  ) {
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
          data: {
            content: "⚠️ No session bound to this channel. Provide a session_id.",
          },
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
          await deps.transport.editOriginalInteractionResponse(
            deps.applicationId,
            parsed.interactionToken,
            { content },
          );
        } catch (err) {
          await deps.transport.editOriginalInteractionResponse(
            deps.applicationId,
            parsed.interactionToken,
            {
              content: `⚠️ \`${controlOp.op}\` failed: ${String(err)}`,
            },
          );
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
          data: {
            content: "⚠️ No session bound to this channel. Provide a session_id.",
          },
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
          const entries = r.entries as Array<{
            index: number;
            priority: string;
            label: string;
            enqueuedAt: number;
          }>;
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

  if (controlOp.op === "elevation_grant" || controlOp.op === "elevation_revoke") {
    try {
      const payload = { ...controlOp.payload };
      if (!payload.session_id && deps.resolveSessionForChannel) {
        const resolved = deps.resolveSessionForChannel(parsed.channelId, parsed.guildId);
        if (resolved) payload.session_id = resolved;
      }
      if (!payload.session_id && controlOp.op === "elevation_grant") {
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: {
            content: "⚠️ No session bound to this channel. Provide a session_id.",
          },
        });
        return;
      }
      const res = await deps.invokeControlOp(controlOp.op, payload);
      let content: string;
      if (res.ok && res.result) {
        const r = res.result as Record<string, unknown>;
        if (controlOp.op === "elevation_grant") {
          content = `🔓 Elevation granted for \`${r.sessionId ?? payload.session_id}\` (expires: ${r.expiresAt ?? "unknown"}, grant: \`${r.id ?? "?"}\`)`;
        } else {
          const count = r.revokedCount ?? (r.revoked === true ? 1 : 0);
          content = `🔒 Elevation revoked. ${count} grant(s) removed.`;
        }
      } else {
        content = `⚠️ \`${controlOp.op}\` failed: ${res.error ?? "unknown error"}`;
      }
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content },
      });
    } catch (err) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: `⚠️ Elevation failed: ${String(err)}` },
      });
    }
    return;
  }

  await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: { content: `Unhandled operation: \`${controlOp.op}\`` },
  });
}
