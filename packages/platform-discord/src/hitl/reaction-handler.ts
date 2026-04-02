import type { DiscordReactionAddEvent } from "../adapter";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import type { Logger } from "../daemon-types";
import type { PendingActionsStore, HitlAutoApproveGate } from "../daemon-types";
import type { HitlDiscordNoticeRegistry } from "./notice-registry";

const RESOLVER = "discord:owner:reaction";

type HitlDiscordReactionKind = "once" | "session" | "agent" | "deny";

/** Classify standard unicode reactions on HITL notices (custom emoji ignored). */
export function classifyHitlDiscordReaction(emoji: {
  readonly id: string | null;
  readonly name: string | null;
}): HitlDiscordReactionKind | null {
  if (emoji.id != null) return null;
  const n = emoji.name ?? "";
  if (n === "❌") return "deny";
  if (n === "✅") return "session";
  // Permanent / "forever" (U+267E); Discord may omit or include VS16 (U+FE0F)
  if (n === "♾️" || n === "♾" || n === "\u267E" || n === "\u267E\uFE0F") return "agent";
  if (n === "1️⃣" || /^1\uFE0F?\u20E3$/.test(n)) return "once";
  return null;
}

function applyKind(input: {
  readonly kind: HitlDiscordReactionKind;
  readonly pendingId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly pending: PendingActionsStore;
  readonly autoApprove: HitlAutoApproveGate;
}): void {
  const { kind, pendingId, sessionId, toolName, pending, autoApprove } = input;
  switch (kind) {
    case "once":
      pending.approve(pendingId, RESOLVER);
      return;
    case "deny":
      pending.deny(pendingId, RESOLVER);
      return;
    case "session": {
      for (const row of pending.listPendingForSession(sessionId)) {
        if (row.toolName === toolName) pending.approve(row.id, RESOLVER);
      }
      autoApprove.enableSessionTool(sessionId, toolName);
      return;
    }
    case "agent": {
      const parsed = parseAgentSessionUrn(sessionId);
      if (!parsed) return;
      const { agentId } = parsed;
      for (const row of pending.listAllPending()) {
        const p = parseAgentSessionUrn(row.sessionId);
        if (p?.agentId === agentId && row.toolName === toolName) {
          pending.approve(row.id, RESOLVER);
        }
      }
      autoApprove.enableAgentTool(agentId, toolName);
      return;
    }
  }
}

/**
 * Discord Gateway only: maps owner reactions on registered HITL notices to SQLite pending + auto gates.
 */
export function handleDiscordHitlReactionAdd(input: {
  readonly ev: DiscordReactionAddEvent;
  readonly pending: PendingActionsStore;
  readonly registry: HitlDiscordNoticeRegistry;
  readonly autoApprove: HitlAutoApproveGate;
  readonly ownerUserId: string | undefined;
  readonly botUserIdRef: { current: string | undefined };
  readonly logger: Logger;
}): boolean {
  const owner = input.ownerUserId?.trim();
  if (!owner) return false;
  if (input.ev.userId !== owner) return false;

  const bot = input.botUserIdRef.current?.trim();
  if (bot && input.ev.userId === bot) return false;

  const mapped = input.registry.lookup(input.ev.channelId, input.ev.messageId);
  if (!mapped) return false;

  const kind = classifyHitlDiscordReaction(input.ev.emoji);
  if (!kind) return false;

  try {
    applyKind({
      kind,
      pendingId: mapped.pendingId,
      sessionId: mapped.sessionId,
      toolName: mapped.toolName,
      pending: input.pending,
      autoApprove: input.autoApprove,
    });
    input.logger.info("hitl.discord_reaction_applied", {
      kind,
      pendingId: mapped.pendingId,
      sessionId: mapped.sessionId,
      tool: mapped.toolName,
    });
    return true;
  } catch (e) {
    input.logger.warn("hitl.discord_reaction_apply_failed", { err: String(e), kind });
    return false;
  }
}
