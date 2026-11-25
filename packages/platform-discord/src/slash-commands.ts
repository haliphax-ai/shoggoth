/**
 * Discord slash command registration and interaction handling.
 */

import type { DiscordRestTransport } from "./transport";
import type { DiscordInteractionEvent, DiscordParsedInteraction } from "./interaction";
import {
  discordInteractionToCommand,
  INTERACTION_RESPONSE_CHANNEL_MESSAGE,
  INTERACTION_RESPONSE_DEFERRED,
  INTERACTION_RESPONSE_MODAL,
  INTERACTION_RESPONSE_UPDATE_MESSAGE,
} from "./interaction";
import { translateCommandToControlOp, type ControlOpRequest } from "@shoggoth/daemon/lib";
import {
  buildProviderSelectOptions,
  buildModelSelectOptions,
  encodeModelSelectCustomId,
  decodeModelSelectCustomId,
  type FailoverChainEntry,
  type ProviderConfig,
} from "./model-select";
import { MESSAGES } from "./messages";

/** The set of slash commands Shoggoth registers (guild-scoped). */
const SLASH_COMMANDS = [
  {
    name: "elevate",
    description: "Grant, revoke, or list elevated privileges for a session",
    options: [
      {
        name: "action",
        type: 3, // STRING
        description: "grant, revoke, or list (default: grant)",
        required: false,
        choices: [
          { name: "grant", value: "grant" },
          { name: "revoke", value: "revoke" },
          { name: "list", value: "list" },
        ],
      },
      {
        name: "session_id",
        type: 3,
        description: "Session URN or agent ID (defaults to this channel's session)",
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
    name: "yolo",
    description: "Toggle yolo mode: auto-approve HITL for a session (no elevation)",
    options: [
      {
        name: "action",
        type: 3, // STRING
        description: "on, off, or status (default: on)",
        required: false,
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
          { name: "status", value: "status" },
        ],
      },
      {
        name: "session_id",
        type: 3,
        description: "Session URN or agent ID (defaults to this channel's session)",
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
        description: "Session URN or agent ID to abort",
        required: false,
      },
    ],
  },
  {
    name: "close",
    description: "Kill a subagent session (defaults to this channel's session)",
    options: [
      {
        name: "session_id",
        type: 3, // STRING
        description: "Session URN or agent ID (defaults to this channel's session)",
        required: false,
      },
    ],
  },
  {
    name: "steer",
    description: "Steer a session with an operator prompt",
    options: [
      {
        name: "prompt",
        type: 3, // STRING
        description: "Steering prompt to deliver to the session",
        required: true,
      },
      {
        name: "session_id",
        type: 3, // STRING
        description: "Session URN or agent ID (defaults to this channel's session)",
        required: false,
      },
      {
        name: "delivery",
        type: 3, // STRING
        description: "Response delivery (default: surface)",
        required: false,
        choices: [
          { name: "surface", value: "surface" },
          { name: "internal", value: "internal" },
        ],
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
        description: "Session URN or agent ID",
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
        description: "Session URN or agent ID",
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
        description: "Session URN or agent ID",
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
        description: "Session URN or agent ID",
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
        description: "Session URN or agent ID",
        required: false,
      },
      {
        name: "agent_id",
        type: 3,
        description: "Agent ID (alternative to session_id)",
        required: false,
      },
      {
        name: "model_id",
        type: 3,
        description: "Set the model directly as provider/model instead of opening the picker",
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
        description: "list, remove, clear, or release",
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
        description: "1-based index to remove (as shown by list)",
        required: false,
      },
      {
        name: "range",
        type: 3,
        description: "1-based inclusive range to remove (e.g. 1-4)",
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
        description: "Session URN or agent ID",
        required: false,
      },
    ],
  },
  {
    name: "prompt",
    description: "Run a canned prompt against a session",
    options: [
      {
        name: "slug",
        type: 3, // STRING
        description: "Prompt slug (browse available prompts when omitted)",
        required: false,
      },
      {
        name: "session_id",
        type: 3, // STRING
        description: "Session URN or agent ID (defaults to this channel's session)",
        required: false,
      },
    ],
  },
  {
    name: "cruise",
    description: "Activate or deactivate cruise control (HITL auto-pilot) for a session",
    options: [
      {
        name: "yes",
        type: 3, // STRING
        description: "Guidance for when to approve HITL requests",
        required: false,
      },
      {
        name: "no",
        type: 3, // STRING
        description: "Guidance for when to deny HITL requests",
        required: false,
      },
      {
        name: "escalate",
        type: 3, // STRING
        description: "Guidance for when to escalate HITL requests to the operator",
        required: false,
      },
      {
        name: "model",
        type: 3, // STRING
        description: "Decision model (provider/model); configured default used if omitted",
        required: false,
      },
      {
        name: "session_id",
        type: 3, // STRING
        description: "Session URN or agent ID (defaults to this channel's session)",
        required: false,
      },
    ],
  },
] as const;
/**
 * Register slash commands for each configured guild via bulk overwrite.
 * Discord matches same-named commands during a bulk overwrite, so startup
 * registration is a convergent sync: definitions update in place (snowflake
 * IDs preserved) and stale entries are pruned — IDs stay stable across
 * restarts. The application ID equals the bot user ID for bot applications.
 * Performs no transport calls when `guildIds` is empty. See
 * docs/platform-discord.md ("Slash Commands").
 */
export async function registerDiscordSlashCommands(opts: {
  readonly transport: DiscordRestTransport;
  readonly applicationId: string;
  readonly guildIds: readonly string[];
}): Promise<void> {
  for (const guildId of opts.guildIds) {
    await opts.transport.registerGuildCommands(
      opts.applicationId,
      guildId,
      SLASH_COMMANDS as unknown as Record<string, unknown>[],
    );
  }
}

/** Names of the Shoggoth-registered slash commands (for legacy cleanup matching). */
const SLASH_COMMAND_NAMES = new Set<string>(SLASH_COMMANDS.map((c) => c.name));

/**
 * Migration helper for the switch from global to guild-scoped registration:
 * delete globally-registered commands whose names match Shoggoth commands so
 * they don't linger as duplicates alongside the guild-scoped ones. Foreign
 * global commands (other tooling under the same application) are left alone.
 */
export async function cleanupLegacyGlobalCommands(opts: {
  readonly transport: DiscordRestTransport;
  readonly applicationId: string;
}): Promise<void> {
  const existing = await opts.transport.listGlobalCommands(opts.applicationId);
  for (const cmd of existing) {
    if (SLASH_COMMAND_NAMES.has(cmd.name)) {
      await opts.transport.deleteGlobalCommand(opts.applicationId, cmd.id);
    }
  }
}

/** Component type 1 = ACTION_ROW. */
const ACTION_ROW = 1;
/** Component type 3 = STRING_SELECT. */
const STRING_SELECT = 3;
/** Component type 4 = TEXT_INPUT. */
const TEXT_INPUT = 4;
/** Text input style 1 = SHORT. */
const TEXT_INPUT_SHORT = 1;

// Canned prompt flow: staged inline message updates (slug dropdown → optional
// parameter modal → delivery confirmation), mirroring the /model flow.

/**
 * Dropdown custom_id. Format: `prompt_select|` (no payload). The session is
 * re-derived from the interaction's channel at stage 2, so the full session
 * URN is never embedded — a thread-bound subagent URN (~87 chars) otherwise
 * overflows Discord's 100-char custom_id limit (400 BASE_TYPE_BAD_LENGTH).
 */
const PROMPT_SELECT_PREFIX = "prompt_select|";
/**
 * Modal custom_id prefix. Format: `prompt_modal|<slug>`. Only the slug is
 * carried; the session is re-derived from the interaction's channel at stage 3.
 */
const PROMPT_MODAL_PREFIX = "prompt_modal|";

/**
 * Cruise control activation modal custom_id. Format: `cruise_modal` or
 * `cruise_modal|<model>`. Only the (optional) model is carried — a session
 * URN overflows Discord's 100-char custom_id limit, so the session is
 * re-derived from the interaction's channel at submit time.
 */
const CRUISE_MODAL_ID = "cruise_modal";
const CRUISE_MODAL_PREFIX = "cruise_modal|";

type PromptListEntry = { slug: string; placeholders?: readonly string[] };

/**
 * How a prompt delivery is reported back to Discord in the staged `/prompt`
 * flow, so message A (the slug dropdown) always transitions forward:
 *
 * - `direct-response` — the initial slash response IS the delivery
 *   confirmation; no deferred placeholder, no post-turn edit.
 * - `inline-update` — ACK first with UPDATE_MESSAGE (7), rewriting message A
 *   in place (dropdown selection and modal submits). Details:
 *   docs/platform-discord.md ("Slash Commands").
 */
type PromptReplyStyle = "direct-response" | "inline-update";

/** The unbound-channel warning text shared by every session-resolution guard. */
const UNBOUND_SESSION_WARNING = MESSAGES.unboundSessionWarning;

/**
 * Transport body types only declare `content`/`flags`, but Discord's
 * interaction-callback and PATCH endpoints both accept `components`. Extras
 * ride in this local before serialization — a fresh inline literal with
 * `components` would fail excess-property checks (the field is still
 * serialized to Discord's request body).
 */
type CallbackDataExtras = { readonly components?: ReadonlyArray<Record<string, unknown>> };

/**
 * Resolve the target session for an interaction: the explicit `session_id`
 * from the command payload, else the channel's bound session. When nothing
 * resolves, answer the interaction with the unbound-channel warning (the
 * response type and delivery shape are per-site divergences, preserved by the
 * `warn` callback: it fires with the shared warning text before the undefined
 * return).
 */
async function resolveSessionOrRespond(
  deps: DiscordInteractionHandlerDeps,
  payload: Readonly<Record<string, unknown>>,
  channelId: string,
  guildId: string | undefined,
  warn: (content: string) => Promise<void>,
): Promise<string | undefined> {
  if (payload.session_id) return payload.session_id as string;
  const resolved = deps.resolveSessionForChannel?.(channelId, guildId);
  if (resolved) return resolved;
  await warn(UNBOUND_SESSION_WARNING);
  return undefined;
}

/**
 * Shared "Enter Model" free-text modal (type 9) with a single required short
 * input — opened when no provider list is available to render pickers.
 */
function buildEnterModelModal(): {
  readonly title: string;
  readonly custom_id: string;
  readonly components: [
    {
      readonly type: number;
      readonly components: [
        {
          readonly type: number;
          readonly custom_id: string;
          readonly label: string;
          readonly style: number;
          readonly required: boolean;
          readonly placeholder: string;
        },
      ];
    },
  ];
} {
  return {
    title: MESSAGES.enterModelModalTitle,
    custom_id: encodeModelSelectCustomId("custom_modal"),
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
  };
}

/**
 * Invoke `session_model` with a model selection and report the ✅/⚠️ outcome
 * through `callback` (one call per divergent site: in-place message rewrite,
 * plain channel message, ...). Never throws for control-op failures —
 * transport failures inside `callback` still propagate to the caller.
 */
async function setSessionModel(
  deps: DiscordInteractionHandlerDeps,
  payload: Readonly<Record<string, unknown>>,
  model: string,
  callback: (content: string) => Promise<void>,
): Promise<void> {
  let content: string;
  try {
    const res = await deps.invokeControlOp("session_model", {
      ...payload,
      model_selection: { model },
    });
    content = res.ok
      ? `✅ Model set to \`${model}\``
      : MESSAGES.failedSetModel(res.error ?? "unknown error");
  } catch (err) {
    content = MESSAGES.failedSetModel(String(err));
  }
  await callback(content);
}

/**
 * Reshape the models-config provider list (name-keyed models → id/name
 * tuples) for the select-menu option builders. Read-only input; the returned
 * list is safe to share across builder calls.
 */
function toProviderConfigList(
  providers: ReadonlyArray<{
    id: string;
    name: string;
    models?: ReadonlyArray<{ name: string }>;
  }>,
): ProviderConfig[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models?.map((m) => ({ id: m.name, name: m.name })) || [],
  }));
}

/** Reshape the models-config failover chain for the option builders. */
function toFailoverChainList(
  failoverChain: ReadonlyArray<{ providerId: string; model: string }> | undefined,
): FailoverChainEntry[] {
  return (failoverChain ?? []).map((e) => ({
    providerId: e.providerId,
    modelId: e.model,
  }));
}

/**
 * Translate the prompt options to a control op, resolving the target session
 * from the interaction's channel when the payload carries none, then run the
 * op — which returns as soon as the prompt is delivered — and report that
 * delivery per `replyStyle` (see
 * {@link PromptReplyStyle}). A failure rewrites the status message; a
 * successful run never does (the turn announces itself on the session's
 * delivery surface).
 */
async function runPromptProxy(
  deps: DiscordInteractionHandlerDeps,
  interactionId: string,
  interactionToken: string,
  options: Record<string, string>,
  channelId: string,
  guildId: string | undefined,
  replyStyle: PromptReplyStyle,
): Promise<void> {
  const controlOp = translateCommandToControlOp({ name: "prompt", options });
  if (!controlOp) return;
  // Same session-resolution pattern as the slash-command branches: fall back
  // to the channel's bound session when the payload does not carry one.
  const payload = { ...controlOp.payload };
  const sessionId = await resolveSessionOrRespond(
    deps,
    payload,
    channelId,
    guildId,
    async (content) => {
      await deps.transport.interactionCallback(interactionId, interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content },
      });
    },
  );
  if (!sessionId) return;
  payload.session_id = sessionId;
  // `wait: false` — the op returns once the prompt is delivered, so the delivery
  // confirmation below is the whole status. The turn runs detached; no post-turn edit.
  payload.wait = false;
  const submitted = `✅ Canned prompt \`${options.slug}\` submitted to session \`${payload.session_id}\`.`;
  // Terminal-state editor: every terminal state clears components so the
  // message never keeps an inert slug dropdown (or modal-era inputs) around.
  const edit = async (content: string): Promise<void> => {
    const data: { content: string } & CallbackDataExtras = { content, components: [] };
    try {
      await deps.transport.editOriginalInteractionResponse(
        deps.applicationId,
        interactionToken,
        data,
      );
    } catch (err) {
      deps.logger.warn("discord.interaction.prompt_reply_undeliverable", {
        interactionId,
        err: String(err),
      });
    }
  };
  const invoke = async (): Promise<{ ok: boolean; error?: string } | Error> => {
    try {
      return await deps.invokeControlOp(controlOp.op, payload);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  };
  if (replyStyle === "inline-update") {
    // ACK FIRST with UPDATE_MESSAGE (7): satisfies the ~3s window and rewrites
    // message A in place with the delivery confirmation. If type 7 is rejected,
    // fall back to DEFERRED (5) — never a second POST after a successful first ack.
    let deferredFallback = false;
    try {
      try {
        await deps.transport.interactionCallback(interactionId, interactionToken, {
          type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
          data: { content: submitted, components: [] },
        });
      } catch (err) {
        deps.logger.warn("discord.interaction.prompt_ack_failed", {
          interactionId,
          err: String(err),
        });
        await deps.transport.interactionCallback(interactionId, interactionToken, {
          type: INTERACTION_RESPONSE_DEFERRED,
        });
        deferredFallback = true;
      }
    } catch (err) {
      deps.logger.warn("discord.interaction.prompt_defer_failed", {
        interactionId,
        err: String(err),
      });
    }
    const res = await invoke();
    if (res instanceof Error || !res.ok) {
      await edit(
        MESSAGES.failedPrompt(res instanceof Error ? res.message : (res.error ?? "unknown error")),
      );
      return;
    }
    // Success needs no edit — the ack already shows the delivery confirmation.
    // Only the deferred fallback (a bare "thinking" placeholder) still has to
    // be rewritten.
    if (deferredFallback) await edit(submitted);
    return;
  }
  // direct-response: no message A to preserve, and the op returns as soon as
  // the prompt is delivered, so the initial slash response IS the delivery
  // confirmation — no deferred "thinking" placeholder, no post-turn edit.
  const res = await invoke();
  const content =
    res instanceof Error || !res.ok
      ? MESSAGES.failedPrompt(res instanceof Error ? res.message : (res.error ?? "unknown error"))
      : submitted;
  await deps.transport.interactionCallback(interactionId, interactionToken, {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: { content },
  });
}

/**
 * Shared parameter-modal logic for the canned-prompt flow: opens a type-9
 * modal (`prompt_modal|<slug>`) with one text input per placeholder so stage
 * 3 can rebuild the params and re-derive the session from the channel. More
 * than 5 placeholders → guard error delivered per `guardStyle` (in-place
 * update on the dropdown path, ephemeral response on the slash path). Callers
 * must invoke this only with a non-empty placeholders list. Details:
 * docs/platform-discord.md ("Slash Commands").
 */
async function respondWithPromptParameterModal(
  deps: DiscordInteractionHandlerDeps,
  interactionId: string,
  interactionToken: string,
  slug: string,
  placeholders: readonly string[],
  guardStyle: "update-message" | "ephemeral-channel",
): Promise<void> {
  if (placeholders.length > 5) {
    // Same wording on every path; only the delivery mechanics differ — the
    // dropdown path updates message A in place, the slash path answers the
    // command ephemerally.
    await deps.transport.interactionCallback(interactionId, interactionToken, {
      type:
        guardStyle === "update-message"
          ? INTERACTION_RESPONSE_UPDATE_MESSAGE
          : INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: {
        content: MESSAGES.promptTooManyParameters(slug, placeholders.length),
        components: [],
        ...(guardStyle === "ephemeral-channel" ? { flags: 64 } : {}),
      },
    });
    return;
  }
  // One text input per placeholder; the input custom_id carries the
  // parameter name so the modal submit can rebuild the params record.
  const components = placeholders.map((name) => ({
    type: ACTION_ROW,
    components: [
      {
        type: TEXT_INPUT,
        custom_id: name,
        label: name.slice(0, 32),
        style: TEXT_INPUT_SHORT,
        required: false, // empty values are valid; key must still be present
        ...(placeholders.length === 1 ? { placeholder: `Value for ${name}` } : {}),
      },
    ],
  }));
  await deps.transport.interactionCallback(interactionId, interactionToken, {
    type: INTERACTION_RESPONSE_MODAL,
    data: {
      title: `Prompt: ${slug}`.slice(0, 45),
      custom_id: `${PROMPT_MODAL_PREFIX}${slug}`,
      components,
    },
  });
}

/**
 * Open the cruise control activation modal. `yes` (approve guidance) and `no`
 * (deny guidance) are required inputs, prefilled with any values already
 * provided on the command; `escalate` is optional. When a model was provided
 * while the required guidance is incomplete, the model rides in the modal
 * custom_id (short provider/model refs only — the session is re-derived from
 * the channel at submit; a session URN would overflow the 100-char limit).
 */
async function respondWithCruiseModal(
  deps: DiscordInteractionHandlerDeps,
  interactionId: string,
  interactionToken: string,
  prefill: { yes?: string; no?: string; escalate?: string; model?: string },
): Promise<void> {
  const customIdWithModel = prefill.model ? `${CRUISE_MODAL_PREFIX}${prefill.model}` : undefined;
  const customId =
    customIdWithModel && customIdWithModel.length <= 100 ? customIdWithModel : CRUISE_MODAL_ID;
  const textInput = (id: string, label: string, required: boolean, value?: string) => ({
    type: ACTION_ROW,
    components: [
      {
        type: TEXT_INPUT,
        custom_id: id,
        label,
        style: TEXT_INPUT_SHORT,
        required,
        ...(value ? { value } : {}),
      },
    ],
  });
  await deps.transport.interactionCallback(interactionId, interactionToken, {
    type: INTERACTION_RESPONSE_MODAL,
    data: {
      title: "Cruise Control",
      custom_id: customId,
      components: [
        textInput("yes", "Approve guidance", true, prefill.yes),
        textInput("no", "Deny guidance", true, prefill.no),
        textInput("escalate", "Escalate guidance (optional)", false, prefill.escalate),
      ],
    },
  });
}

export interface DiscordInteractionHandlerDeps {
  readonly transport: Pick<
    DiscordRestTransport,
    "interactionCallback" | "editOriginalInteractionResponse"
  >;
  readonly applicationId: string;
  /**
   * Guild IDs this instance owns (the same set slash commands are registered
   * in). Interactions from any other guild are dropped before any branch runs —
   * with NO interaction callback — so that when multiple daemons share one bot
   * token, only the owning instance answers its guild's interactions.
   * Absent or empty disables the guard (DM-only deployments).
   */
  readonly ownedGuildIds?: readonly string[];
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
  // Guild-ownership guard: daemons sharing one bot token all receive every
  // INTERACTION_CREATE. Drop foreign-guild interactions WITHOUT acknowledging —
  // the single-use callback token would race the owning instance's response.
  if (
    ev.guildId !== undefined &&
    deps.ownedGuildIds !== undefined &&
    deps.ownedGuildIds.length > 0 &&
    !deps.ownedGuildIds.includes(ev.guildId)
  ) {
    deps.logger.debug("discord.interaction.foreign_guild_ignored", {
      type: ev.type,
      id: ev.id,
      guildId: ev.guildId,
    });
    return;
  }

  // Component interactions (type 3) and modal submits (type 5) route on their
  // interaction type; everything else is a slash command routed on its
  // translated control op.
  if (ev.type === 3 || ev.type === 5) {
    const componentHandler = COMPONENT_ROUTE[ev.type];
    if (componentHandler) await componentHandler({ deps, ev });
    return;
  }
  await handleSlashCommandInteraction({ deps, ev });
}

/** Context handed to every component-route handler. */
interface InteractionContext {
  readonly deps: DiscordInteractionHandlerDeps;
  readonly ev: DiscordInteractionEvent;
}

/**
 * Route table for component (type 3) and modal (type 5) interactions. Both
 * stages share one handler per interaction type: the `custom_id` prefix and
 * (for model selects) the decoded step select the flow inside.
 */
const COMPONENT_ROUTE: Readonly<Record<number, (ctx: InteractionContext) => Promise<void>>> = {
  3: handleComponentInteraction,
  5: handleModalSubmitInteraction,
};

/**
 * Route table for slash commands: control op name → handler. Three ops share
 * a formatted-response handler (session context trio) and three share the
 * elevation guard variant; every other op gets its own cohesive handler.
 */
const COMMAND_OP_ROUTES: Readonly<Record<string, (ctx: SlashCommandContext) => Promise<void>>> = {
  session_abort: handleSessionAbort,
  session_kill: handleSessionKill,
  session_steer: handleSessionSteer,
  hitl_cruise_control: handleCruiseCommand,
  prompt: handlePromptCommand,
  session_context_status: handleStatusCommand,
  session_model: handleModelCommand,
  session_context_new: handleContextChange,
  session_context_reset: handleContextChange,
  session_compact: handleContextChange,
  session_queue_manage: handleQueueCommand,
  elevation_grant: handleElevationCommand,
  elevation_revoke: handleElevationCommand,
  elevation_list: handleElevationCommand,
  yolo_mode: handleYoloCommand,
};

/** Context for a parsed slash-command interaction. */
interface SlashCommandContext extends InteractionContext {
  readonly parsed: DiscordParsedInteraction;
  readonly controlOp: ControlOpRequest;
}

/**
 * Route a slash command through {@link COMMAND_OP_ROUTES}. Parsing, command
 * logging, and the unknown-command / unknown-op guard rails are shared here
 * so each op handler only implements its own flow.
 */
async function handleSlashCommandInteraction(ctx: InteractionContext): Promise<void> {
  const { deps, ev } = ctx;
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

  const handler = COMMAND_OP_ROUTES[controlOp.op];
  if (!handler) {
    await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: { content: `Unhandled operation: \`${controlOp.op}\`` },
    });
    return;
  }
  await handler({ deps, ev, parsed, controlOp });
}

/**
 * Respond with a plain channel message. The `flags` parameter keeps the two
 * flag shapes used by the op handlers (plain vs. ephemeral) explicit at the
 * call sites instead of a spread.
 */
async function respondChannelMessage(
  deps: DiscordInteractionHandlerDeps,
  interactionId: string,
  interactionToken: string,
  content: string,
  flags?: number,
): Promise<void> {
  await deps.transport.interactionCallback(interactionId, interactionToken, {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: flags !== undefined ? { content, flags } : { content },
  });
}

/**
 * Fill in the target session from the command payload, else the channel's
 * bound session. Returns null (after answering the interaction with the
 * unbound-channel warning) when neither resolves.
 */
async function requireSession(
  ctx: SlashCommandContext,
  payload: Record<string, unknown>,
  flags?: number,
): Promise<string | null> {
  const { deps, parsed } = ctx;
  if (!payload.session_id && deps.resolveSessionForChannel) {
    const resolved = deps.resolveSessionForChannel(parsed.channelId, parsed.guildId);
    if (resolved) payload.session_id = resolved;
  }
  const sessionId = payload.session_id as string | undefined;
  if (sessionId) return sessionId;
  await respondChannelMessage(
    deps,
    parsed.interactionId,
    parsed.interactionToken,
    UNBOUND_SESSION_WARNING,
    flags,
  );
  return null;
}

/**
 * Resolve a session through the shared #711 resolver for the per-op guards.
 * `warnFlags` controls the channel-message flags on the failure response
 * (some ops warn ephemerally, some rewrite the message in place).
 */
async function resolveSlashSession(
  ctx: SlashCommandContext,
  payload: Record<string, unknown>,
  warnFlags?: number,
): Promise<string | undefined> {
  const { deps, parsed } = ctx;
  return resolveSessionOrRespond(deps, payload, parsed.channelId, parsed.guildId, (content) =>
    respondChannelMessage(deps, parsed.interactionId, parsed.interactionToken, content, warnFlags),
  );
}

/**
 * Shared formatted-response body for the status/queue/elevation/yolo ops:
 * invoke the op with its payload and answer with the formatted result (or an
 * error notice on a thrown op).
 */
async function invokeOpAndRespond(
  ctx: SlashCommandContext,
  payload: Record<string, unknown>,
  format: (res: { ok: boolean; result?: unknown; error?: string }) => string,
): Promise<void> {
  const { deps, parsed, controlOp } = ctx;
  try {
    const res = await deps.invokeControlOp(controlOp.op, payload);
    await respondChannelMessage(deps, parsed.interactionId, parsed.interactionToken, format(res));
  } catch (err) {
    await respondChannelMessage(
      deps,
      parsed.interactionId,
      parsed.interactionToken,
      MESSAGES.failedOp(controlOp.op, String(err)),
    );
  }
}

/** `/abort`: abort the channel's active turn (or the given session's). */
async function handleSessionAbort(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed, controlOp } = ctx;
  const { interactionId, interactionToken } = parsed;
  let sessionId = (controlOp.payload.session_id as string | undefined) ?? undefined;
  if (!sessionId && deps.resolveSessionForChannel) {
    const resolved = deps.resolveSessionForChannel(parsed.channelId, parsed.guildId);
    if (resolved) sessionId = resolved;
  }
  let aborted: boolean;
  try {
    aborted = await deps.abortSession(sessionId);
  } catch (err) {
    await respondChannelMessage(
      deps,
      interactionId,
      interactionToken,
      `⚠️ Abort failed: ${String(err)}`,
    );
    return;
  }

  const content = aborted ? "✅ Session abort initiated." : "⚠️ No active session turn to abort.";
  await respondChannelMessage(deps, interactionId, interactionToken, content);
}

/** `/close`: reap a subagent session on this surface (or explicit session_id). */
async function handleSessionKill(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed } = ctx;
  const { interactionId, interactionToken } = parsed;
  const payload = { ...ctx.controlOp.payload };
  const sessionId = await requireSession(ctx, payload);
  if (!sessionId) return;
  // The `subagent_only` guard makes the daemon refuse top-level agent sessions,
  // surfaced here as an operator-facing warning instead of a kill.
  let content: string;
  try {
    const res = await deps.invokeControlOp("session_kill", payload);
    if (res.ok) {
      content = `✅ Closed session \`${payload.session_id}\`.`;
    } else if (res.error && res.error.includes("top-level agent session")) {
      content = `🔒 Close refused: \`${payload.session_id}\` is a top-level agent session. \`/close\` reaps subagent sessions only.`;
    } else {
      content = MESSAGES.failedClose(res.error ?? "unknown error");
    }
  } catch (err) {
    const msg = String(err);
    content = msg.includes("top-level agent session")
      ? `🔒 Close refused: \`${payload.session_id}\` is a top-level agent session. \`/close\` reaps subagent sessions only.`
      : MESSAGES.failedClose(msg);
  }
  await respondChannelMessage(deps, interactionId, interactionToken, content);
}

/**
 * `/steer`: deliver a steering prompt to the session. The op returns once the
 * prompt is delivered (`wait: false`) — the turn runs detached, announced via
 * typing indicator and delivery surface — so the initial slash response
 * reports delivery immediately. No placeholder, no edit.
 */
async function handleSessionSteer(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed } = ctx;
  const { interactionId, interactionToken } = parsed;
  const payload = { ...ctx.controlOp.payload };
  const sessionId = await requireSession(ctx, payload);
  if (!sessionId) return;
  payload.wait = false;
  let steerContent: string;
  try {
    const res = await deps.invokeControlOp("session_steer", payload);
    steerContent = res.ok
      ? `✅ Steering prompt submitted to session \`${payload.session_id}\`.`
      : MESSAGES.failedSteer(res.error ?? "unknown error");
  } catch (err) {
    steerContent = MESSAGES.failedSteer(String(err));
  }
  try {
    await respondChannelMessage(deps, interactionId, interactionToken, steerContent, 64);
  } catch (err) {
    // The steer already ran; an undeliverable status must stay non-fatal
    // (and distinct from a handler error).
    deps.logger.warn("discord.interaction.steer_reply_undeliverable", {
      interactionId,
      sessionId: payload.session_id,
      err: String(err),
    });
  }
}

/**
 * `/cruise` — cruise control (HITL auto-pilot): no options + active →
 * deactivate; no/partial required guidance → prefilled activation modal;
 * all required guidance (yes + no) → activate directly, no modal.
 */
/** `/cruise`: cruise control (HITL auto-pilot) — toggle, modal, or direct activation. */
async function handleCruiseCommand(ctx: SlashCommandContext): Promise<void> {
  const payload = { ...ctx.controlOp.payload };
  const sessionId = await requireSession(ctx, payload);
  if (!sessionId) return;
  const guidance = extractCruiseGuidance(payload);
  if (!guidance.hasGuidance) {
    // No options: deactivate when active, otherwise open the activation modal.
    await handleCruiseToggle(ctx, sessionId);
    return;
  }
  await handleCruiseWithGuidance(ctx, guidance, sessionId);
}

/** Required/optional cruise guidance extracted from the command payload. */
interface CruiseGuidance {
  readonly yes?: string;
  readonly no?: string;
  readonly escalate?: string;
  readonly model?: string;
  readonly hasGuidance: boolean;
}

/** Pull trimmed guidance fields from the `/cruise` payload. */
function extractCruiseGuidance(payload: Record<string, unknown>): CruiseGuidance {
  const asGuidance = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const yes = asGuidance(payload.yes);
  const no = asGuidance(payload.no);
  const escalate = asGuidance(payload.escalate);
  const model = asGuidance(payload.model);
  return {
    yes,
    no,
    escalate,
    model,
    hasGuidance:
      yes !== undefined || no !== undefined || escalate !== undefined || model !== undefined,
  };
}

/** `/cruise` with no options: deactivate when active, else open the modal. */
async function handleCruiseToggle(ctx: SlashCommandContext, sessionId: string): Promise<void> {
  const { deps, parsed } = ctx;
  const { interactionId, interactionToken } = parsed;
  let active = false;
  try {
    const res = await deps.invokeControlOp("hitl_cruise_control", { session_id: sessionId });
    active = Boolean(res.ok && (res.result as { active?: boolean } | undefined)?.active);
  } catch (err) {
    deps.logger.warn("discord.interaction.cruise_status_failed", {
      interactionId,
      err: String(err),
    });
  }
  if (!active) {
    await respondWithCruiseModal(deps, interactionId, interactionToken, {});
    return;
  }
  let content: string;
  try {
    const res = await deps.invokeControlOp("hitl_cruise_control", {
      session_id: sessionId,
      deactivate: true,
    });
    content = res.ok
      ? `🚗 Cruise control deactivated for \`${sessionId}\`.`
      : MESSAGES.failedDeactivateCruise(res.error ?? "unknown error");
  } catch (err) {
    content = MESSAGES.failedDeactivateCruise(String(err));
  }
  await respondChannelMessage(deps, interactionId, interactionToken, content);
}

/**
 * `/cruise` with guidance: complete yes+no activates directly; anything
 * partial reopens the modal prefilled with what was provided.
 */
/**
 * `/cruise` with guidance: complete yes+no activates directly; anything
 * partial reopens the modal prefilled with what was provided.
 */
async function handleCruiseWithGuidance(
  ctx: SlashCommandContext,
  guidance: CruiseGuidance,
  sessionId: string,
): Promise<void> {
  const { deps, parsed } = ctx;
  const { interactionId, interactionToken } = parsed;
  const { yes, no, escalate, model } = guidance;
  if (yes === undefined || no === undefined) {
    // Partial guidance — modal prefilled with whatever was provided.
    await respondWithCruiseModal(deps, interactionId, interactionToken, {
      ...(yes ? { yes } : {}),
      ...(no ? { no } : {}),
      ...(escalate ? { escalate } : {}),
      ...(model ? { model } : {}),
    });
    return;
  }
  // Complete required guidance — activate directly, no modal.
  let content: string;
  try {
    const res = await deps.invokeControlOp("hitl_cruise_control", {
      session_id: sessionId,
      yes,
      no,
      ...(escalate ? { escalate } : {}),
      ...(model ? { model } : {}),
    });
    if (res.ok) {
      await reportCruiseActivation(ctx, sessionId, escalate, res.result);
      return;
    }
    content = MESSAGES.failedActivateCruise(res.error ?? "unknown error");
  } catch (err) {
    content = MESSAGES.failedActivateCruise(String(err));
  }
  await respondChannelMessage(deps, interactionId, interactionToken, content);
}

/** Report a successful cruise activation with per-warning suffix lines. */
async function reportCruiseActivation(
  ctx: SlashCommandContext,
  sessionId: string,
  escalate: string | undefined,
  result: unknown,
): Promise<void> {
  const { deps, parsed } = ctx;
  const r = result as { warnings?: string[] } | undefined;
  const warnings = r?.warnings ?? [];
  await respondChannelMessage(
    deps,
    parsed.interactionId,
    parsed.interactionToken,
    MESSAGES.cruiseActivated(sessionId, escalate, warnings),
  );
}

/** `/prompt`: browse the workspace-scoped prompt list or run a canned prompt. */
async function handlePromptCommand(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed } = ctx;
  const payload = { ...ctx.controlOp.payload };
  const sessionId = await requireSession(ctx, payload);
  if (!sessionId) return;
  const list = await fetchPromptList(deps, payload.session_id as string);
  const requestedSlug = typeof payload.slug === "string" ? payload.slug : undefined;
  const plan = planPromptReply(list, requestedSlug, payload.session_id as string);
  if (plan.kind === "error") {
    await respondChannelMessage(
      deps,
      parsed.interactionId,
      parsed.interactionToken,
      plan.content,
      plan.flags,
    );
    return;
  }
  await dispatchPromptPlan(ctx, plan);
}

/** Result of fetching the canned prompt list for a session. */
type PromptListResult =
  | { kind: "error"; content: string; flags?: number }
  | { kind: "ok"; prompts: PromptListEntry[] };

/** Fetch the workspace-scoped canned prompt list for a session. */
async function fetchPromptList(
  deps: DiscordInteractionHandlerDeps,
  sessionId: string,
): Promise<PromptListResult> {
  try {
    const res = await deps.invokeControlOp("prompt_list", { session_id: sessionId });
    if (!res.ok) {
      return {
        kind: "error",
        content: MESSAGES.failedListPrompts(res.error ?? "unknown error"),
      };
    }
    const prompts = (res.result as { prompts?: PromptListEntry[] } | undefined)?.prompts ?? [];
    return { kind: "ok", prompts };
  } catch (err) {
    return { kind: "error", content: MESSAGES.failedListPrompts(String(err)) };
  }
}

/**
 * Decide how the `/prompt` interaction proceeds from the prompt list and the
 * (optional) requested slug. Pure decision layer — the caller performs the
 * returned plan's side effects.
 */
/**
 * Decide how the `/prompt` interaction proceeds from the prompt list and the
 * (optional) requested slug. Pure decision layer — the caller performs the
 * returned plan's side effects.
 */
function planPromptReply(
  list: PromptListResult,
  requestedSlug: string | undefined,
  sessionId: string,
): PromptReplyPlan {
  if (list.kind === "error") {
    return { kind: "error", content: list.content, flags: list.flags };
  }
  const guardError = promptListGuard(list.prompts, requestedSlug);
  if (guardError) {
    return { kind: "error", content: guardError, flags: 64 };
  }
  const requestedEntry = requestedSlug
    ? list.prompts.find((p) => p.slug === requestedSlug)
    : undefined;
  if (requestedSlug && requestedEntry && (requestedEntry.placeholders ?? []).length === 0) {
    // Slug given and the prompt takes no parameters: skip the dropdown
    // confirmation round-trip entirely and run it directly (the slash
    // response itself reports the delivery).
    return { kind: "run-direct", slug: requestedSlug, sessionId };
  }
  if (requestedSlug && requestedEntry) {
    // Slug given and the prompt HAS placeholders: go straight to the parameter
    // modal as the initial response. A pre-selected dropdown is a dead end —
    // Discord never fires onchange for `default_values` pre-selection.
    return {
      kind: "modal",
      slug: requestedSlug,
      placeholders: requestedEntry.placeholders ?? [],
    };
  }
  // Slug omitted — stage 1: interactive selection via the dropdown.
  return { kind: "dropdown", prompts: list.prompts, sessionId };
}

/**
 * Ephemeral-guard wording for a fetched prompt list: the requested slug must
 * exist and the list must not be empty. Returns the error content, or null
 * when the list is usable.
 */
function promptListGuard(
  prompts: PromptListEntry[],
  requestedSlug: string | undefined,
): string | null {
  if (requestedSlug && !prompts.some((p) => p.slug === requestedSlug)) {
    return `⚠️ Prompt not found: \`${requestedSlug}\``;
  }
  if (prompts.length === 0) {
    return "No canned prompts available.";
  }
  return null;
}

/** What to do after the prompt list resolves. */
type PromptReplyPlan =
  | { kind: "error"; content: string; flags?: number }
  | { kind: "run-direct"; slug: string; sessionId: string }
  | { kind: "modal"; slug: string; placeholders: readonly string[] }
  | { kind: "dropdown"; prompts: PromptListEntry[]; sessionId: string };

/** Perform the prompt flow decided by {@link planPromptReply}. */
async function dispatchPromptPlan(
  ctx: SlashCommandContext,
  plan: Exclude<PromptReplyPlan, { kind: "error" }>,
): Promise<void> {
  const { deps, ev, parsed } = ctx;
  const { interactionId, interactionToken, channelId, guildId } = parsed;
  if (plan.kind === "run-direct") {
    await runPromptProxy(
      deps,
      interactionId,
      interactionToken,
      {
        slug: plan.slug,
        session_id: plan.sessionId,
        platform_user_id: ev.userId,
      },
      channelId,
      guildId,
      "direct-response",
    );
    return;
  }
  if (plan.kind === "modal") {
    await respondWithPromptParameterModal(
      deps,
      interactionId,
      interactionToken,
      plan.slug,
      plan.placeholders,
      "ephemeral-channel",
    );
    return;
  }
  // Slug omitted — stage 1: interactive selection via the dropdown.
  const options = plan.prompts.map((p) => ({
    label: p.slug.slice(0, 100),
    value: p.slug,
  }));
  const selectComponent: Record<string, unknown> = {
    type: STRING_SELECT,
    // Session is re-derived at stage 2 from this channel — never embed the
    // (potentially long) session URN in custom_id.
    custom_id: PROMPT_SELECT_PREFIX,
    placeholder: "Select a canned prompt",
    options,
  };
  await deps.transport.interactionCallback(interactionId, interactionToken, {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: {
      content: `📜 **Canned Prompts**\nSession: \`${plan.sessionId}\``,
      flags: 64, // Ephemeral
      components: [{ type: ACTION_ROW, components: [selectComponent] }],
    },
  });
}

/** `/status`: formatted session status card (id, state, model, stats, queue). */
/** `/status`: formatted session status card (id, state, model, stats, queue). */
async function handleStatusCommand(ctx: SlashCommandContext): Promise<void> {
  const payload = { ...ctx.controlOp.payload };
  const sessionId = await resolveSlashSession(ctx, payload);
  if (!sessionId) return;
  payload.session_id = sessionId;
  await invokeOpAndRespond(ctx, payload, (res) => {
    if (res.ok && res.result) {
      return formatStatusResult(res.result as Record<string, unknown>);
    }
    return MESSAGES.failedOp("session_context_status", res.error ?? "unknown error");
  });
}

/** Render the `/status` result payload as the session status card. */
function formatStatusResult(r: Record<string, unknown>): string {
  if (r.session === null) {
    return "Session not found.";
  }
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
  return lines.filter(Boolean).join("\n");
}

/** `/model`: direct model assignment shortcut or the picker menus. */
/** `/model`: direct model assignment shortcut or the picker menus. */
async function handleModelCommand(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed, controlOp } = ctx;
  const { interactionId, interactionToken } = parsed;
  // Optional `model_id` shortcut: assign the model directly and skip the
  // modal/dropdown picker. Same provider/model validation as the modal path.
  const modelId = parsed.command.options.model_id?.trim();
  if (modelId) {
    const invalid = isInvalidModelId(modelId);
    if (invalid) {
      await respondChannelMessage(deps, interactionId, interactionToken, invalid);
      return;
    }
    const shortcutPayload = { ...controlOp.payload };
    const shortcutSessionId = await resolveSlashSession(ctx, shortcutPayload);
    if (!shortcutSessionId && !shortcutPayload.agent_id) {
      return;
    }
    if (shortcutSessionId) shortcutPayload.session_id = shortcutSessionId;
    await setSessionModel(deps, shortcutPayload, modelId, async (content) => {
      await respondChannelMessage(deps, interactionId, interactionToken, content);
    });
    return;
  }
  await respondWithModelPicker(ctx);
}

/** Open the provider/model picker menus for `/model` (modal fallback when no providers). */
async function respondWithModelPicker(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed, controlOp } = ctx;
  const { interactionId, interactionToken } = parsed;
  try {
    const payload = { ...controlOp.payload };
    const sessionId = await resolveSlashSession(ctx, payload);
    if (!sessionId) return;

    // Get current model (read-only, no model_selection in payload)
    const currentModelRes = await deps.invokeControlOp(controlOp.op, {
      session_id: sessionId,
    });

    const { currentProviderId, currentModel } = extractCurrentModelSelection(currentModelRes);

    // Get models configuration
    const modelsConfig = deps.getModelsConfig ? await deps.getModelsConfig() : null;

    if (!modelsConfig || !modelsConfig.providers || modelsConfig.providers.length === 0) {
      // No providers available - respond with modal for free-text input
      await deps.transport.interactionCallback(interactionId, interactionToken, {
        type: INTERACTION_RESPONSE_MODAL,
        data: buildEnterModelModal(),
      });
      return;
    }
    const providers = toProviderConfigList(modelsConfig.providers);

    // Build provider select options
    const providerOptions = buildProviderSelectOptions({
      providers,
      currentProviderId,
    });

    // Build current model display
    const currentModelDisplay =
      currentProviderId && currentModel ? `\`${currentProviderId}/${currentModel}\`` : "Not set";

    // Respond with both provider and model select menus
    // Determine which provider to show models for (current or first available)
    const activeProviderId = currentProviderId || providers[0]?.id;
    const modelOptions = activeProviderId
      ? buildModelSelectOptions({
          providerId: activeProviderId,
          providers,
          failoverChain: toFailoverChainList(modelsConfig.failoverChain),
        })
      : [];

    const components: Record<string, unknown>[] = [
      {
        type: ACTION_ROW,
        components: [
          {
            type: STRING_SELECT,
            custom_id: encodeModelSelectCustomId("provider"),
            placeholder: "Select a provider",
            options: providerOptions,
          },
        ],
      },
    ];

    if (modelOptions.length > 0) {
      components.push({
        type: ACTION_ROW,
        components: [
          {
            type: STRING_SELECT,
            custom_id: encodeModelSelectCustomId("model", activeProviderId),
            placeholder: "Select a model",
            options: modelOptions,
          },
        ],
      });
    }

    await deps.transport.interactionCallback(interactionId, interactionToken, {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: {
        content: `🎯 **Model Configuration**\nSession: \`${payload.session_id}\`\nCurrent: ${currentModelDisplay}`,
        flags: 64, // Ephemeral
        components,
      },
    });
  } catch (err) {
    await respondChannelMessage(
      deps,
      interactionId,
      interactionToken,
      `⚠️ Model command failed: ${String(err)}`,
    );
  }
}

/** Current provider/model extracted from a `session_model` read result. */
interface CurrentModelSelection {
  readonly currentProviderId?: string;
  readonly currentModel?: string;
}

/** Extract the effective provider/model for picker defaults. */
function extractCurrentModelSelection(res: {
  ok: boolean;
  result?: unknown;
}): CurrentModelSelection {
  if (!res.ok || !res.result) {
    return {};
  }
  const r = res.result as Record<string, unknown>;
  // Check explicit model_selection override first
  const modelSel = r.model_selection as Record<string, unknown> | null | undefined;
  if (modelSel && typeof modelSel.model === "string") {
    const m = modelSel.model as string;
    const slashIdx = m.indexOf("/");
    if (slashIdx > 0) {
      return { currentProviderId: m.slice(0, slashIdx), currentModel: m.slice(slashIdx + 1) };
    }
  }
  // Fall back to first failoverChain entry from effective config
  const effectiveModels = r.effective_models as Record<string, unknown> | null;
  if (effectiveModels) {
    const chain = effectiveModels.failoverChain as string[] | undefined;
    if (chain && chain.length > 0) {
      const first = chain[0];
      const slashIdx = first.indexOf("/");
      if (slashIdx > 0) {
        return {
          currentProviderId: first.slice(0, slashIdx),
          currentModel: first.slice(slashIdx + 1),
        };
      }
    }
  }
  return {};
}

/** Validate a `provider/model` reference for the `/model` shortcut path. */
function isInvalidModelId(modelId: string): string | undefined {
  const slashIdx = modelId.indexOf("/");
  return slashIdx < 1 || slashIdx === modelId.length - 1
    ? MESSAGES.invalidModelId(modelId)
    : undefined;
}

/**
 * `/new`, `/reset`, `/compact`: session-context lifecycle ops. `/compact` can
 * take a long time (model summarization call) — it defers the response first
 * and edits the deferred placeholder with the outcome; the other two answer
 * directly.
 */
async function handleContextChange(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed, controlOp } = ctx;
  const { interactionId, interactionToken } = parsed;
  const isCompact = controlOp.op === "session_compact";
  try {
    const payload = { ...controlOp.payload };
    const sessionId = await requireSession(ctx, payload);
    if (!sessionId) return;

    if (isCompact) {
      // Compact can take a long time (model summarization call) — defer the
      // response and edit the placeholder with the outcome.
      await deps.transport.interactionCallback(interactionId, interactionToken, {
        type: INTERACTION_RESPONSE_DEFERRED,
      });
      try {
        const res = await deps.invokeControlOp(controlOp.op, payload);
        const content = res.ok
          ? `✅ \`${controlOp.op}\` completed.`
          : MESSAGES.failedOp(controlOp.op, res.error ?? "unknown error");
        await deps.transport.editOriginalInteractionResponse(deps.applicationId, interactionToken, {
          content,
        });
      } catch (err) {
        await deps.transport.editOriginalInteractionResponse(deps.applicationId, interactionToken, {
          content: MESSAGES.failedOp(controlOp.op, String(err)),
        });
      }
      return;
    }

    const res = await deps.invokeControlOp(controlOp.op, payload);
    const content = res.ok
      ? `✅ \`${controlOp.op}\` completed.`
      : MESSAGES.failedOp(controlOp.op, res.error ?? "unknown error");
    await respondChannelMessage(deps, interactionId, interactionToken, content);
  } catch (err) {
    await respondChannelMessage(
      deps,
      interactionId,
      interactionToken,
      MESSAGES.failedOp(controlOp.op, String(err)),
    );
  }
}

/** `/queue`: formatted queue listing, removal counts, and errors. */
async function handleQueueCommand(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed } = ctx;
  try {
    const payload = { ...ctx.controlOp.payload };
    const sessionId = await requireSession(ctx, payload);
    if (!sessionId) return;
    await invokeOpAndRespond(ctx, payload, (res) => {
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
      return content;
    });
  } catch (err) {
    await respondChannelMessage(
      deps,
      parsed.interactionId,
      parsed.interactionToken,
      `⚠️ Queue failed: ${String(err)}`,
    );
  }
}

/** `/elevate`: grant, revoke, or list elevation — same guard, three formats. */
/** `/elevate`: grant, revoke, or list elevation — same guard, three formats. */
/** `/elevate`: grant, revoke, or list elevation — same guard, three formats. */
async function handleElevationCommand(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed } = ctx;
  const { interactionId, interactionToken } = parsed;
  try {
    const payload = { ...ctx.controlOp.payload };
    const sessionId = await requireSession(ctx, payload);
    if (!sessionId && ctx.controlOp.op === "elevation_grant") {
      return;
    }
    await invokeOpAndRespond(ctx, payload, (res) => formatElevationResult(ctx, res, payload));
  } catch (err) {
    await respondChannelMessage(
      deps,
      interactionId,
      interactionToken,
      `⚠️ Elevation failed: ${String(err)}`,
    );
  }
}

/** Render the elevation op result for grant / list / revoke. */
function formatElevationResult(
  ctx: SlashCommandContext,
  res: { ok: boolean; result?: unknown; error?: string },
  payload: Record<string, unknown>,
): string {
  if (res.ok && res.result) {
    const r = res.result as Record<string, unknown>;
    if (ctx.controlOp.op === "elevation_grant") {
      return `🔓 Elevation granted for \`${r.sessionId ?? payload.session_id}\` (expires: ${r.expiresAt ?? "unknown"}, grant: \`${r.id ?? "?"}\`)`;
    }
    if (ctx.controlOp.op === "elevation_list") {
      const grants = (r.grants ?? []) as Array<{
        id: string;
        sessionId: string;
        expiresAt: string;
      }>;
      if (grants.length === 0) {
        return "📋 No active elevation grants.";
      }
      const lines = grants.map(
        (g) => `• \`${g.id}\` — \`${g.sessionId}\` (expires: ${g.expiresAt})`,
      );
      return `📋 Active elevation grants (${grants.length}):\n${lines.join("\n")}`;
    }
    const count = r.revokedCount ?? (r.revoked === true ? 1 : 0);
    return `🔒 Elevation revoked. ${count} grant(s) removed.`;
  }
  return MESSAGES.failedOp(ctx.controlOp.op, res.error ?? "unknown error");
}

/** `/yolo`: toggle (or query) the per-session HITL auto-approve flag. */
/** `/yolo`: toggle (or query) the per-session HITL auto-approve flag. */
async function handleYoloCommand(ctx: SlashCommandContext): Promise<void> {
  const { deps, parsed } = ctx;
  try {
    const payload = { ...ctx.controlOp.payload };
    const sessionId = await requireSession(ctx, payload);
    if (!sessionId) return;
    await invokeOpAndRespond(ctx, payload, (res) => formatYoloResult(res, payload));
  } catch (err) {
    await respondChannelMessage(
      deps,
      parsed.interactionId,
      parsed.interactionToken,
      `⚠️ Yolo mode failed: ${String(err)}`,
    );
  }
}

/** Render the yolo_mode op result (status query vs. toggle wording). */
function formatYoloResult(
  res: { ok: boolean; result?: unknown; error?: string },
  payload: Record<string, unknown>,
): string {
  if (res.ok && res.result) {
    const r = res.result as Record<string, unknown>;
    const sessionId = r.sessionId ?? payload.session_id;
    const isStatus = payload.action === "status";
    if (r.enabled === true) {
      return isStatus
        ? `🤖 Yolo mode status for \`${sessionId}\`: ON — HITL auto-approved until cleared.`
        : `🤖 Yolo mode ON for \`${sessionId}\` — HITL auto-approved until cleared.`;
    }
    return isStatus
      ? `🤖 Yolo mode status for \`${sessionId}\`: OFF.`
      : `🤖 Yolo mode OFF for \`${sessionId}\`.`;
  }
  return MESSAGES.failedOp("yolo_mode", res.error ?? "unknown error");
}

/**
 * Stage-2 entry for canned prompts (type 3): slug dropdown selected. The
 * session is re-derived from the channel (never carried in custom_id — a
 * thread-bound subagent URN overflows Discord's 100-char limit). No
 * placeholders → immediate `inline-update` prompt run rewriting message A;
 * placeholders → shared parameter modal, stage 3 rewrites message A. `/prompt`
 * with a slug argument opens the same modal directly.
 */
/**
 * Stage-2 entry for canned prompts (type 3): slug dropdown selected. The
 * session is re-derived from the channel (never carried in custom_id — a
 * thread-bound subagent URN overflows Discord's 100-char limit). No
 * placeholders → immediate `inline-update` prompt run rewriting message A;
 * placeholders → shared parameter modal, stage 3 rewrites message A. `/prompt`
 * with a slug argument opens the same modal directly.
 */
async function handleComponentInteraction(ctx: InteractionContext): Promise<void> {
  const { deps, ev } = ctx;
  const customId = ev.data?.custom_id;
  if (!customId) {
    deps.logger.debug("discord.interaction.ignored", {
      type: ev.type,
      id: ev.id,
    });
    return;
  }

  if (customId.startsWith(PROMPT_SELECT_PREFIX)) {
    await handlePromptSelectStage(ctx);
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

  const { step, extra } = decoded;
  // The session is not encoded in custom_id (Discord's 100-char limit breaks
  // for long thread-bound subagent URNs); re-derive it from the channel.
  const sessionId = await resolveSessionOrRespond(
    deps,
    {},
    ev.channelId,
    ev.guildId,
    async (content) => {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content, flags: 64 },
      });
    },
  );
  if (!sessionId) return;

  switch (step) {
    case "provider":
      await handleModelProviderStep(ctx, sessionId);
      break;
    case "model":
      await handleModelSelectStep(ctx, sessionId, extra);
      break;
    // Unknown step - ignore
  }
}

/**
 * Canned-prompt slug dropdown (type 3, stage 2): look up the prompt's
 * placeholders for the re-derived session, then run the prompt inline (no
 * parameters) or open the shared parameter modal (stage 3 rewrites message A).
 */
async function handlePromptSelectStage(ctx: InteractionContext): Promise<void> {
  const { deps, ev } = ctx;
  const values = ev.data?.values;
  if (!values || values.length === 0) return;
  const slug = values[0];
  // The session is no longer carried in custom_id (100-char limit); re-derive
  // from the channel. Cross-channel `session_id` override is only honored on
  // the direct-run path; staged flows target the bound session.
  const sessionId = await resolveSessionOrRespond(
    deps,
    {},
    ev.channelId,
    ev.guildId,
    async (content) => {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content, flags: 64 },
      });
    },
  );
  if (!sessionId) return;
  let placeholders: readonly string[] = [];
  try {
    const res = await deps.invokeControlOp("prompt_list", { session_id: sessionId });
    if (res.ok && res.result) {
      const prompts = (res.result as { prompts?: PromptListEntry[] }).prompts ?? [];
      placeholders = prompts.find((p) => p.slug === slug)?.placeholders ?? [];
    }
  } catch (err) {
    deps.logger.warn("discord.interaction.prompt_list_failed", {
      sessionId,
      err: String(err),
    });
  }
  if (placeholders.length === 0) {
    // No placeholders — nothing to ask. ACK FIRST with UPDATE_MESSAGE (7)
    // so message A is immediately rewritten in place with the delivery
    // confirmation (dropdown cleared).
    await runPromptProxy(
      deps,
      ev.id,
      ev.token,
      { slug, session_id: sessionId, platform_user_id: ev.userId },
      ev.channelId,
      ev.guildId,
      "inline-update",
    );
    return;
  }
  // Placeholders → shared parameter modal. Message A stays visible while the
  // modal is open (Discord text inputs exist only inside modals); stage 3
  // rewrites message A when the modal is submitted.
  await respondWithPromptParameterModal(
    deps,
    ev.id,
    ev.token,
    slug,
    placeholders,
    "update-message",
  );
}

/**
 * Stage-3 entry for canned prompts (type 5): modal submitted. Rebuilds the
 * params from the inputs, re-derives the session from the channel, and runs
 * the prompt with an `inline-update` rewrite of message A. Also routes model
 * modal submits (`custom_modal` step) and cruise-control activations.
 */
/**
 * Stage-3 entry for canned prompts (type 5): modal submitted. Rebuilds the
 * params from the inputs, re-derives the session from the channel, and runs
 * the prompt with an `inline-update` rewrite of message A. Also routes model
 * modal submits (`custom_modal` step) and cruise-control activations.
 */
async function handleModalSubmitInteraction(ctx: InteractionContext): Promise<void> {
  const customId = ctx.ev.data?.custom_id;
  if (!customId) {
    ctx.deps.logger.debug("discord.interaction.ignored", {
      type: ctx.ev.type,
      id: ctx.ev.id,
    });
    return;
  }

  if (customId === CRUISE_MODAL_ID || customId.startsWith(CRUISE_MODAL_PREFIX)) {
    await handleCruiseModalSubmit(ctx, customId);
    return;
  }
  if (customId.startsWith(PROMPT_MODAL_PREFIX)) {
    await handlePromptModalSubmit(ctx, customId);
    return;
  }
  await handleModelModalSubmit(ctx, customId);
}

/**
 * Cruise control activation modal (type 5) submitted → activate and report.
 * The session is re-derived from the channel (never in custom_id — 100-char
 * limit); an optional model rides in the custom_id suffix.
 */
async function handleCruiseModalSubmit(ctx: InteractionContext, customId: string): Promise<void> {
  const { deps, ev } = ctx;
  const model = customId.startsWith(CRUISE_MODAL_PREFIX)
    ? customId.slice(CRUISE_MODAL_PREFIX.length)
    : undefined;
  const sessionId = await resolveSessionOrRespond(
    deps,
    {},
    ev.channelId,
    ev.guildId,
    async (content) => {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content },
      });
    },
  );
  if (!sessionId) return;
  const inputs: Record<string, string> = {};
  for (const row of ev.data?.components ?? []) {
    const input = row.components?.[0];
    if (input && typeof input.custom_id === "string") {
      inputs[input.custom_id] = input.value ?? "";
    }
  }
  const yes = inputs.yes?.trim();
  const no = inputs.no?.trim();
  const escalate = inputs.escalate?.trim();
  if (!yes || !no) {
    await deps.transport.interactionCallback(ev.id, ev.token, {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: {
        content: "⚠️ Approve (`yes`) and deny (`no`) guidance are both required.",
      },
    });
    return;
  }
  let content: string;
  try {
    const res = await deps.invokeControlOp("hitl_cruise_control", {
      session_id: sessionId,
      yes,
      no,
      ...(escalate ? { escalate } : {}),
      ...(model ? { model } : {}),
    });
    if (res.ok) {
      const warnings = (res.result as { warnings?: string[] } | undefined)?.warnings ?? [];
      content = MESSAGES.cruiseActivated(sessionId, escalate, warnings);
    } else {
      content = MESSAGES.failedActivateCruise(res.error ?? "unknown error");
    }
  } catch (err) {
    content = MESSAGES.failedActivateCruise(String(err));
  }
  await deps.transport.interactionCallback(ev.id, ev.token, {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: { content },
  });
}

/**
 * Stage 3: canned prompt modal submitted → run the prompt and rewrite
 * message A (the dropdown) with the final recap. custom_id carries only the
 * slug (`prompt_modal|<slug>`); the session is NOT embedded (a thread-bound
 * subagent URN overflows Discord's 100-char custom_id limit).
 */
async function handlePromptModalSubmit(ctx: InteractionContext, customId: string): Promise<void> {
  const { deps, ev } = ctx;
  const slug = customId.slice(PROMPT_MODAL_PREFIX.length);
  if (!slug) return;
  // Rebuild params from the inputs; every placeholder key must be present
  // even when the user left the field empty (empty values are valid).
  const params: Record<string, string> = {};
  for (const row of ev.data?.components ?? []) {
    const input = row.components?.[0];
    if (input && typeof input.custom_id === "string") {
      params[input.custom_id] = input.value ?? "";
    }
  }
  await runPromptProxy(
    deps,
    ev.id,
    ev.token,
    {
      slug,
      platform_user_id: ev.userId,
      ...params,
    },
    ev.channelId,
    ev.guildId,
    // ACK FIRST with UPDATE_MESSAGE (7), rewriting message A in place
    // with the delivery confirmation (type 6 is invalid for modal
    // submits — component interactions only).
    "inline-update",
  );
}

/**
 * Model free-text modal (`custom_modal` step) submitted → validate the
 * `provider/model` value and assign it, rewriting message A in place.
 */
async function handleModelModalSubmit(ctx: InteractionContext, customId: string): Promise<void> {
  const { deps, ev } = ctx;
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

  // The session is not encoded in custom_id (Discord's 100-char limit breaks
  // for long thread-bound subagent URNs); re-derive it from the channel.
  const sessionId = await resolveSessionOrRespond(
    deps,
    {},
    ev.channelId,
    ev.guildId,
    async (content) => {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
        data: { content, components: [] },
      });
    },
  );
  if (!sessionId) return;

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

  await applyModelTextInput(deps, ev.id, ev.token, sessionId, value);
}

/**
 * Validate the free-text `provider/model` value and assign it to the session
 * (invalid format rewrites message A with the warning; a valid value flows
 * through the shared setter and rewrites message A with the outcome).
 */
async function applyModelTextInput(
  deps: DiscordInteractionHandlerDeps,
  interactionId: string,
  interactionToken: string,
  sessionId: string,
  value: string,
): Promise<void> {
  if (!value.includes("/")) {
    await deps.transport.interactionCallback(interactionId, interactionToken, {
      type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
      data: {
        content: MESSAGES.invalidModelId(value),
        components: [],
      },
    });
    return;
  }
  await setSessionModel(deps, { session_id: sessionId }, value, async (content) => {
    await deps.transport.interactionCallback(interactionId, interactionToken, {
      type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
      data: { content, components: [] },
    });
  });
}

/**
 * Model-select `provider` step (type 3): show the custom-entry modal for the
 * `(custom)` option, otherwise rewrite message A with the model menu for the
 * newly selected provider (provider row re-rendered with it highlighted).
 */
async function handleModelProviderStep(ctx: InteractionContext, sessionId: string): Promise<void> {
  const { deps, ev } = ctx;
  const values = ev.data?.values;
  if (!values || values.length === 0) {
    return;
  }
  const value = values[0];

  if (value === "__custom__") {
    // Respond with modal for custom input
    await deps.transport.interactionCallback(ev.id, ev.token, {
      type: INTERACTION_RESPONSE_MODAL,
      data: buildEnterModelModal(),
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

  const providers = toProviderConfigList(modelsConfig.providers);

  // Build model options
  const modelOptions = buildModelSelectOptions({
    providerId: value,
    providers,
    failoverChain: toFailoverChainList(modelsConfig.failoverChain),
  });

  // Rebuild provider options with the newly selected provider highlighted
  const providerOptions = buildProviderSelectOptions({
    providers,
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
              custom_id: encodeModelSelectCustomId("provider"),
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
              custom_id: encodeModelSelectCustomId("model", value),
              placeholder: "Select a model",
              options: modelOptions,
            },
          ],
        },
      ],
    },
  });
}

/**
 * Model-select `model` step (type 3): assign the picked model to the session
 * and rewrite message A in place with the ✅/⚠️ outcome.
 */
async function handleModelSelectStep(
  ctx: InteractionContext,
  sessionId: string,
  extra: string | undefined,
): Promise<void> {
  const { deps, ev } = ctx;
  const values = ev.data?.values;
  if (!values || values.length === 0) {
    return;
  }
  const selectedModel = values[0];
  const providerId = extra;

  if (!providerId) {
    return;
  }

  await setSessionModel(
    deps,
    { session_id: sessionId },
    `${providerId}/${selectedModel}`,
    async (content) => {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
        data: { content, components: [] },
      });
    },
  );
}
