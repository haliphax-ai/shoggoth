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

/** The set of slash commands Shoggoth registers (guild-scoped). */
const SLASH_COMMANDS = [
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
 *
 * Discord matches existing commands by name during a bulk overwrite: same-named
 * commands are updated in place (their snowflake IDs are preserved), missing
 * ones are created, and unknown leftovers are pruned. Startup registration is
 * therefore a convergent sync — command IDs stay stable across restarts as
 * long as nothing tears the list down.
 *
 * The application ID equals the bot user ID for bot applications. Performs no
 * transport calls when `guildIds` is empty (guild commands cannot exist
 * without a guild).
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

// ---------------------------------------------------------------------------
// Canned prompt flow: staged inline message updates (slug dropdown →
// optional parameter modal → delivery confirmation), mirroring the /model flow
// ---------------------------------------------------------------------------

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
 * How a prompt delivery is reported back to Discord. Each stage of the
 * staged `/prompt` flow uses a different style so message A (the slug
 * dropdown) always transitions forward instead of being left behind:
 *
 * - `direct-response` — the prompt op returns as soon as the prompt is
 *   delivered, so the slash command's initial response IS the delivery
 *   confirmation (`✅ Canned prompt … submitted to session …`). No deferred
 *   "thinking" placeholder and no post-turn edit.
 * - `inline-update` — ACK FIRST with UPDATE_MESSAGE (7), rewriting message A
 *   in place with the same delivery confirmation. Used by BOTH the
 *   slug-dropdown selection (no placeholders) and modal submits: Discord text
 *   inputs are modal-only, so message A stays visible as the dropdown while
 *   the modal is open and is rewritten here once the parameters are known.
 *   For the dropdown selection the rewrite clears the dropdown immediately.
 *
 * Either way the status is posted the moment the prompt is delivered — the
 * turn keeps running detached and announces itself via the typing indicator
 * and the session's delivery surface. Only a failure rewrites the status
 * afterwards (into `⚠️ Prompt failed: …`).
 */
type PromptReplyStyle = "direct-response" | "inline-update";

/**
 * Translate the prompt options to a control op, resolving the target session
 * from the interaction's channel when the payload carries none (responding
 * with the unbound-channel warning instead of running the op when there is
 * nothing to target), then run the op — which returns as soon as the prompt
 * is delivered — and report that delivery per `replyStyle` (see
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
  if (!payload.session_id && deps.resolveSessionForChannel) {
    const resolved = deps.resolveSessionForChannel(channelId, guildId);
    if (resolved) payload.session_id = resolved;
  }
  if (!payload.session_id) {
    await deps.transport.interactionCallback(interactionId, interactionToken, {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: { content: "⚠️ No session bound to this channel. Provide a session_id." },
    });
    return;
  }
  // `wait: false` — the op returns as soon as the prompt is delivered to the
  // agent, so the delivery confirmation below is the whole status. The turn
  // keeps running detached and is announced by the typing indicator and the
  // session's delivery surface, so there is no post-turn status edit.
  payload.wait = false;
  const submitted = `✅ Canned prompt \`${options.slug}\` submitted to session \`${payload.session_id}\`.`;
  // Terminal-state editor: every terminal state clears components so the
  // message never keeps an inert slug dropdown (or modal-era inputs) around.
  const edit = async (content: string): Promise<void> => {
    // Held in a variable: the transport body type only declares `content`, so
    // a fresh inline literal with `components` would fail excess-property
    // checks (the field is still serialized to Discord's PATCH body).
    const data = { content, components: [] as Array<Record<string, unknown>> };
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
    // ACK FIRST with UPDATE_MESSAGE (7): this satisfies the ~3s window AND
    // rewrites message A (the dropdown) in place with the delivery
    // confirmation, so the dropdown is cleared immediately instead of sitting
    // inert for the whole model turn. If Discord rejects type 7 the first ack
    // throws — only then fall back to DEFERRED (5) and report the outcome by
    // editing that deferred response. Never send a second POST after a
    // successful first ack.
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
        `⚠️ Prompt failed: ${res instanceof Error ? res.message : (res.error ?? "unknown error")}`,
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
      ? `⚠️ Prompt failed: ${res instanceof Error ? res.message : (res.error ?? "unknown error")}`
      : submitted;
  await deps.transport.interactionCallback(interactionId, interactionToken, {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: { content },
  });
}

/**
 * Shared parameter-modal logic for the canned-prompt flow, used by both the
 * slug-dropdown handler (stage 2) and the `/prompt` slash command when the
 * slug arrives as an argument. Select-menu pre-selection never fires the
 * onchange event, so a slug WITH placeholders must open this modal directly
 * instead of routing through a pre-selected dropdown (a dead end).
 *
 * - More than 5 placeholders → guard error, delivered per `guardStyle`:
 *   in-place message update on the dropdown path, ephemeral slash response.
 * - Placeholders present → type-9 modal with `custom_id`
 *   `prompt_modal|<slug>`, so stage 3 rebuilds the params from the input
 *   custom_ids and re-derives the session from the interaction's channel.
 *
 * Callers must only invoke this with a non-empty placeholders list; the
 * no-placeholders shortcut (run the prompt directly) belongs to each caller.
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
        content: `⚠️ Prompt \`${slug}\` has ${placeholders.length} parameters; Discord modals support at most 5.`,
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
  // Guild-ownership guard: multiple daemons sharing one bot token all receive
  // every INTERACTION_CREATE, so an instance must only answer interactions
  // from its own guilds. Drop foreign-guild interactions WITHOUT acknowledging
  // them: the interaction callback token is single-use, so any response here
  // would race (and can beat) the owning instance's response. Guild-less
  // interactions (DMs) pass through; an absent/empty ownedGuildIds disables
  // the guard entirely (DM-only deployments).
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

    // Stage 2: canned prompt slug dropdown selected. No placeholders →
    // immediate UPDATE_MESSAGE (7) delivery confirmation on message A;
    // placeholders → modal (9), after which stage 3 rewrites message A on
    // submit. The
    // /prompt slash command with a slug argument opens the same modal
    // directly when the prompt has placeholders (bypassing this dropdown).
    if (customId.startsWith(PROMPT_SELECT_PREFIX)) {
      const values = ev.data?.values;
      if (!values || values.length === 0) return;
      const slug = values[0];
      // The session is no longer carried in custom_id (Discord's 100-char limit
      // overflows for long thread-bound subagent URNs). Re-derive it from the
      // interaction's channel, which resolves subagent sessions via the dynamic
      // thread binding. NOTE: an explicit cross-channel `session_id` override is
      // intentionally only honored on the direct-run path (slug + no placeholders);
      // this staged browse/modal flow always targets the channel-bound session.
      const sessionId = deps.resolveSessionForChannel?.(ev.channelId, ev.guildId);
      if (!sessionId) {
        await deps.transport.interactionCallback(ev.id, ev.token, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: { content: "⚠️ No session bound to this channel.", flags: 64 },
        });
        return;
      }
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
      // Placeholders present → shared parameter modal. Message A stays
      // visible while the modal is open — unavoidable, since Discord text
      // inputs exist only inside modals; stage 3 rewrites message A when
      // the modal is submitted.
      await respondWithPromptParameterModal(
        deps,
        ev.id,
        ev.token,
        slug,
        placeholders,
        "update-message",
      );
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
    const sessionId = deps.resolveSessionForChannel?.(ev.channelId, ev.guildId);
    if (!sessionId) {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: "⚠️ No session bound to this channel.", flags: 64 },
      });
      return;
    }

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

    // Cruise control activation modal submitted → activate and report.
    // The session is re-derived from the channel (never embedded in the
    // custom_id — thread-bound subagent URNs overflow the 100-char limit);
    // an optional model rides in the custom_id suffix.
    if (customId === CRUISE_MODAL_ID || customId.startsWith(CRUISE_MODAL_PREFIX)) {
      const model = customId.startsWith(CRUISE_MODAL_PREFIX)
        ? customId.slice(CRUISE_MODAL_PREFIX.length)
        : undefined;
      const sessionId = deps.resolveSessionForChannel?.(ev.channelId, ev.guildId);
      if (!sessionId) {
        await deps.transport.interactionCallback(ev.id, ev.token, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: { content: "⚠️ No session bound to this channel." },
        });
        return;
      }
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
          const warnSuffix = warnings.length
            ? `\n${warnings.map((w) => `⚠️ ${w}`).join("\n")}`
            : "";
          content = `🚗 Cruise control activated for \`${sessionId}\`${escalate ? " (with escalation route)" : ""}.${warnSuffix}`;
        } else {
          content = `⚠️ Failed to activate cruise control: ${res.error ?? "unknown error"}`;
        }
      } catch (err) {
        content = `⚠️ Failed to activate cruise control: ${String(err)}`;
      }
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content },
      });
      return;
    }

    // Stage 3: canned prompt modal submitted → run the prompt and rewrite
    // message A (the dropdown) with the final recap.
    if (customId.startsWith(PROMPT_MODAL_PREFIX)) {
      // custom_id carries only the slug (`prompt_modal|<slug>`); the session is
      // NOT embedded (a thread-bound subagent URN overflows Discord's 100-char
      // custom_id limit). runPromptProxy resolves it from this channel.
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

    // The session is not encoded in custom_id (Discord's 100-char limit breaks
    // for long thread-bound subagent URNs); re-derive it from the channel.
    const sessionId = deps.resolveSessionForChannel?.(ev.channelId, ev.guildId);
    if (!sessionId) {
      await deps.transport.interactionCallback(ev.id, ev.token, {
        type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
        data: { content: "⚠️ No session bound to this channel.", components: [] },
      });
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
        session_id: sessionId,
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

  if (controlOp.op === "session_kill") {
    // `/close`: reap a subagent session attached to this surface (or an
    // explicit session_id). The `subagent_only` guard in the translated
    // payload makes the daemon refuse top-level agent sessions, which is
    // surfaced here as an operator-facing warning instead of a kill.
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
    let content: string;
    try {
      const res = await deps.invokeControlOp("session_kill", payload);
      if (res.ok) {
        content = `✅ Closed session \`${payload.session_id}\`.`;
      } else if (res.error && res.error.includes("top-level agent session")) {
        content = `🔒 Close refused: \`${payload.session_id}\` is a top-level agent session. \`/close\` reaps subagent sessions only.`;
      } else {
        content = `⚠️ Close failed: ${res.error ?? "unknown error"}`;
      }
    } catch (err) {
      const msg = String(err);
      content = msg.includes("top-level agent session")
        ? `🔒 Close refused: \`${payload.session_id}\` is a top-level agent session. \`/close\` reaps subagent sessions only.`
        : `⚠️ Close failed: ${msg}`;
    }
    await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: { content },
    });
    return;
  }

  if (controlOp.op === "session_steer") {
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
    // The steer control op returns as soon as the prompt is delivered
    // (`wait: false`) — the turn keeps running detached and announces itself
    // via the typing indicator and the session's delivery surface — so the
    // initial slash response reports the delivery immediately. No deferred
    // "thinking" placeholder, no post-turn edit.
    payload.wait = false;
    let steerContent: string;
    try {
      const res = await deps.invokeControlOp("session_steer", payload);
      steerContent = res.ok
        ? `✅ Steering prompt submitted to session \`${payload.session_id}\`.`
        : `⚠️ Steer failed: ${res.error ?? "unknown error"}`;
    } catch (err) {
      steerContent = `⚠️ Steer failed: ${String(err)}`;
    }
    try {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: steerContent },
      });
    } catch (err) {
      // The steer already ran; an undeliverable status must stay non-fatal
      // (and distinct from a handler error).
      deps.logger.warn("discord.interaction.steer_reply_undeliverable", {
        interactionId: parsed.interactionId,
        sessionId: payload.session_id,
        err: String(err),
      });
    }
    return;
  }

  if (controlOp.op === "hitl_cruise_control") {
    // `/cruise` — cruise control (HITL auto-pilot):
    // - No options + active → deactivate.
    // - No options (or partial required guidance) → activation modal, prefilled
    //   with whatever was provided.
    // - All required guidance (yes + no) → activate directly, no modal.
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
    const asGuidance = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const yes = asGuidance(payload.yes);
    const no = asGuidance(payload.no);
    const escalate = asGuidance(payload.escalate);
    const model = asGuidance(payload.model);
    const hasGuidance =
      yes !== undefined || no !== undefined || escalate !== undefined || model !== undefined;

    const reportActivation = async (result: unknown, sessionId: string): Promise<void> => {
      const r = result as { warnings?: string[] } | undefined;
      const warnings = r?.warnings ?? [];
      const warnSuffix = warnings.length ? `\n${warnings.map((w) => `⚠️ ${w}`).join("\n")}` : "";
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: {
          content: `🚗 Cruise control activated for \`${sessionId}\`${escalate ? " (with escalation route)" : ""}.${warnSuffix}`,
        },
      });
    };

    if (!hasGuidance) {
      // Toggle: deactivate when active, otherwise open the activation modal.
      let active = false;
      try {
        const res = await deps.invokeControlOp("hitl_cruise_control", {
          session_id: payload.session_id,
        });
        active = Boolean(res.ok && (res.result as { active?: boolean } | undefined)?.active);
      } catch (err) {
        deps.logger.warn("discord.interaction.cruise_status_failed", {
          interactionId: parsed.interactionId,
          err: String(err),
        });
      }
      if (active) {
        let content: string;
        try {
          const res = await deps.invokeControlOp("hitl_cruise_control", {
            session_id: payload.session_id,
            deactivate: true,
          });
          content = res.ok
            ? `🚗 Cruise control deactivated for \`${payload.session_id}\`.`
            : `⚠️ Failed to deactivate cruise control: ${res.error ?? "unknown error"}`;
        } catch (err) {
          content = `⚠️ Failed to deactivate cruise control: ${String(err)}`;
        }
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: { content },
        });
        return;
      }
      await respondWithCruiseModal(deps, parsed.interactionId, parsed.interactionToken, {});
      return;
    }

    if (yes !== undefined && no !== undefined) {
      // Complete required guidance — activate directly, no modal.
      let content: string;
      try {
        const res = await deps.invokeControlOp("hitl_cruise_control", {
          session_id: payload.session_id,
          yes,
          no,
          ...(escalate ? { escalate } : {}),
          ...(model ? { model } : {}),
        });
        if (res.ok) {
          await reportActivation(res.result, payload.session_id as string);
          return;
        }
        content = `⚠️ Failed to activate cruise control: ${res.error ?? "unknown error"}`;
      } catch (err) {
        content = `⚠️ Failed to activate cruise control: ${String(err)}`;
      }
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content },
      });
      return;
    }

    // Partial guidance — modal prefilled with whatever was provided.
    await respondWithCruiseModal(deps, parsed.interactionId, parsed.interactionToken, {
      ...(yes ? { yes } : {}),
      ...(no ? { no } : {}),
      ...(escalate ? { escalate } : {}),
      ...(model ? { model } : {}),
    });
    return;
  }

  if (controlOp.op === "prompt") {
    // Resolve the target session first — the prompt list is workspace-scoped.
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
    const requestedSlug = typeof payload.slug === "string" ? payload.slug : undefined;
    let prompts: PromptListEntry[] = [];
    try {
      const res = await deps.invokeControlOp("prompt_list", {
        session_id: payload.session_id,
      });
      if (!res.ok) {
        await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
          type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
          data: { content: `⚠️ Failed to list prompts: ${res.error ?? "unknown error"}` },
        });
        return;
      }
      prompts = (res.result as { prompts?: PromptListEntry[] } | undefined)?.prompts ?? [];
    } catch (err) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: { content: `⚠️ Failed to list prompts: ${String(err)}` },
      });
      return;
    }
    if (requestedSlug && !prompts.some((p) => p.slug === requestedSlug)) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: {
          content: `⚠️ Prompt not found: \`${requestedSlug}\``,
          flags: 64, // Ephemeral
        },
      });
      return;
    }
    if (prompts.length === 0) {
      await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
        type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
        data: {
          content: "No canned prompts available.",
          flags: 64, // Ephemeral
        },
      });
      return;
    }
    const sessionId = payload.session_id as string;
    const requestedEntry = requestedSlug
      ? prompts.find((p) => p.slug === requestedSlug)
      : undefined;
    if (requestedSlug && requestedEntry && (requestedEntry.placeholders ?? []).length === 0) {
      // Slug given and the prompt takes no parameters: skip the dropdown
      // confirmation round-trip entirely and run it directly (the slash
      // response itself reports the delivery).
      await runPromptProxy(
        deps,
        parsed.interactionId,
        parsed.interactionToken,
        {
          slug: requestedSlug,
          session_id: sessionId,
          platform_user_id: ev.userId,
        },
        parsed.channelId,
        parsed.guildId,
        "direct-response",
      );
      return;
    }
    if (requestedSlug && requestedEntry) {
      // Slug given and the prompt HAS placeholders: go straight to the
      // parameter modal as the initial interaction response. A pre-selected
      // dropdown would be a dead end — Discord never fires a select menu's
      // onchange for `default_values` pre-selection, so the flow could not
      // advance to the modal.
      await respondWithPromptParameterModal(
        deps,
        parsed.interactionId,
        parsed.interactionToken,
        requestedSlug,
        requestedEntry.placeholders ?? [],
        "ephemeral-channel",
      );
      return;
    }
    // Slug omitted — stage 1: interactive selection via the dropdown.
    const options = prompts.map((p) => ({
      label: p.slug.slice(0, 100),
      value: p.slug,
    }));
    const selectComponent: Record<string, unknown> = {
      type: STRING_SELECT,
      // Session is re-derived at stage 2 from this channel — never embed the
      // (potentially long) session URN in custom_id.
      custom_id: `${PROMPT_SELECT_PREFIX}`,
      placeholder: "Select a canned prompt",
      options,
    };
    await deps.transport.interactionCallback(parsed.interactionId, parsed.interactionToken, {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: {
        content: `📜 **Canned Prompts**\nSession: \`${sessionId}\``,
        flags: 64, // Ephemeral
        components: [{ type: ACTION_ROW, components: [selectComponent] }],
      },
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
            custom_id: encodeModelSelectCustomId("custom_modal"),
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
              custom_id: encodeModelSelectCustomId("provider"),
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
              custom_id: encodeModelSelectCustomId("model", activeProviderId),
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
