/**
 * Reaction passthrough: route a Discord emoji reaction into the session's
 * model turn as a `reaction` system-context event, extracted from platform.ts
 * behind an explicit deps parameter (no platform-closure capture). Routing
 * (age → legend → global → discard) lives in `routeReaction`; the routed
 * context becomes a messaging_surface turn's user content.
 */

import { parseAgentSessionUrn, type ShoggothConfig } from "@shoggoth/shared";
import {
  formatGlobalReactionEventContext,
  formatAdhocReactionEventContext,
  routeReaction,
} from "@shoggoth/daemon/lib";
import type { Logger } from "./daemon-types";
import { resolveReactionConfig } from "./config";

/** A Discord reaction routed to a session for model consumption. */
export interface DiscordReactionPassthroughEvent {
  readonly sessionId: string;
  readonly messageContent: string;
  readonly messageTimestamp: number;
  readonly emoji: string;
  readonly userId: string;
}

/** Deps for `handleReactionPassthrough`; resolved per call so config-layering
 *  changes (configRef) are observed like the original platform closure did. */
export interface ReactionPassthroughDeps {
  /** Layered config value (no `configRef` configured). */
  readonly config: ShoggothConfig;
  /** Live config reference; `current` wins over `config` when set. */
  readonly configRef?: { current: ShoggothConfig };
  readonly logger: Logger;
  /** The platform's session-model-turn entry (delivery runs the full surface pipeline). */
  readonly runSessionModelTurn: (input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly systemContext: {
      readonly kind: string;
      readonly summary: string;
    };
    readonly delivery: {
      readonly kind: "messaging_surface";
      readonly userId: string;
    };
  }) => Promise<unknown>;
}

/**
 * Handle an emoji reaction as a passthrough turn for the session: route it
 * (age → legend → global), render the event context, and start a
 * messaging_surface turn. Discards are logged at debug; turn failures at warn.
 */
export async function handleReactionPassthrough(
  deps: ReactionPassthroughDeps,
  ev: DiscordReactionPassthroughEvent,
): Promise<void> {
  const cfg = deps.configRef?.current ?? deps.config;
  const agentId = parseAgentSessionUrn(ev.sessionId)?.agentId;
  const agentReactions = agentId ? cfg.agents?.list?.[agentId]?.reactions : undefined;

  const { globalPassthrough, maxAgeMinutes } = resolveReactionConfig(cfg, agentReactions);

  const route = routeReaction({
    emoji: ev.emoji,
    messageContent: ev.messageContent,
    messageTimestamp: ev.messageTimestamp,
    nowMs: Date.now(),
    maxAgeMinutes,
    globalPassthrough,
  });

  if (route.kind === "discard") {
    deps.logger.debug("reaction.passthrough.discard", {
      sessionId: ev.sessionId,
      emoji: ev.emoji,
      reason: route.reason,
    });
    return;
  }

  let eventContext: string;
  if (route.kind === "adhoc") {
    eventContext = formatAdhocReactionEventContext(
      ev.emoji,
      route.legend.entries,
      ev.messageContent,
    );
  } else {
    eventContext = formatGlobalReactionEventContext(ev.emoji, ev.messageContent);
  }

  try {
    await deps.runSessionModelTurn({
      sessionId: ev.sessionId,
      userContent: eventContext,
      systemContext: {
        kind: "reaction",
        summary: `Reaction ${ev.emoji} passthrough`,
      },
      delivery: { kind: "messaging_surface", userId: ev.userId },
    });
  } catch (e) {
    deps.logger.warn("reaction.passthrough.turn_failed", {
      err: String(e),
      sessionId: ev.sessionId,
    });
  }
}
