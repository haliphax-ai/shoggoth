import { formatTokens } from "@shoggoth/daemon/lib";
import type { StatusBarSnapshot, TurnStatusPhase } from "@shoggoth/daemon/lib";
import type { ResolvedStatusBarConfig } from "@shoggoth/shared";

export { formatTokens };

const PHASE_EMOJI: Record<TurnStatusPhase, string> = {
  starting: "⏳",
  thinking: "🧠",
  prose: "💬",
  tool: "⚡",
  paused: "⏸️",
  finished: "✅",
  aborted: "🛑",
  failed: "❌",
};

/**
 * Render the turn status bar as a Discord blockquote line.
 *
 * Sections (status / sequence / tool calls / context / compactions) are
 * joined with the fullwidth vertical bar character (`｜`).
 */
export function renderDiscordStatusBar(
  snap: StatusBarSnapshot,
  cfg: ResolvedStatusBarConfig,
): string {
  const sections: string[] = [];

  if (cfg.statusEnabled) {
    sections.push(PHASE_EMOJI[snap.phase]);
  }

  if (cfg.sequenceEnabled) {
    sections.push(`🔢 \`${snap.sequence}\``);
  }

  // 🚗 — cruise control (HITL auto-pilot) is active for the session.
  if (cfg.cruiseControlEnabled && snap.cruiseControl) {
    sections.push("🚗");
  }

  if (cfg.toolCallsEnabled) {
    const toolSection = formatToolSection(snap);
    if (toolSection !== undefined) sections.push(toolSection);
  }

  if (cfg.subagentsEnabled && snap.subagents && snap.subagents.total > 0) {
    const { total, persistent } = snap.subagents;
    // The persistent parenthetical is omitted when no persistent subagents
    // are active — `(0)` is noise.
    sections.push(`🕵️ \`${total}${persistent > 0 ? ` (${persistent})` : ""}\``);
  }

  if (cfg.timersEnabled && snap.timers && snap.timers > 0) {
    sections.push(`⏰ \`${snap.timers}\``);
  }

  if (cfg.notifyEnabled && snap.notifies && snap.notifies > 0) {
    sections.push(`↩️ \`${snap.notifies}\``);
  }

  if (cfg.contextWindowEnabled && snap.context) {
    const { currentTokens, totalTokens } = snap.context;
    if (totalTokens != null && totalTokens > 0) {
      const percent = ((currentTokens / totalTokens) * 100).toFixed(1);
      // Compact display: `31.4%/100K` (percent of window over abbreviated total).
      sections.push(`🪟 \`${percent}%/${formatTokens(totalTokens)}\``);
    } else {
      // Window unknown: show the fill only — never a bogus percent from
      // dividing the fill by itself.
      sections.push(`🪟 \`~${formatTokens(currentTokens)}\``);
    }
  }

  if (cfg.compactionsEnabled) {
    sections.push(`🗑️ \`${snap.compactions}\``);
  }

  return `> ${sections.join(" ｜ ")}`;
}

function formatToolSection(snap: StatusBarSnapshot): string | undefined {
  const { total, last } = snap.toolCalls;
  if (total === 0 && last === undefined) return undefined;

  const prefix = total > 0 ? `🔧 \`${total}\` ` : "🔧 ";
  if (last === undefined) return prefix.trimEnd();
  const display = last.argPreview ? `${last.name}:${last.argPreview}` : last.name;

  if (last.running) {
    return `${prefix}**${display}**`;
  }
  if (snap.phase === "paused") {
    return `${prefix}\`${display}\``;
  }
  const runtime = last.runtimeMs !== undefined ? ` ${last.runtimeMs}ms` : "";
  return `${prefix}\`${display}\`${runtime}`;
}
