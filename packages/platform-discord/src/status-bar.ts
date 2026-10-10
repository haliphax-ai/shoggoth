import type { StatusBarSnapshot, TurnStatusPhase } from "@shoggoth/daemon/lib";
import type { ResolvedStatusBarConfig } from "@shoggoth/shared";

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

/** `<10K` → plain integer with thousands separators; `≥10K` → one-decimal K; `≥1M` → one-decimal M. */
export function formatTokens(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US");
  if (value < 1_000_000) return trimTrailingZero((value / 1_000).toFixed(1)) + "K";
  return trimTrailingZero((value / 1_000_000).toFixed(1)) + "M";
}

function trimTrailingZero(formatted: string): string {
  return formatted.endsWith(".0") ? formatted.slice(0, -2) : formatted;
}

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

  if (cfg.toolCallsEnabled) {
    const toolSection = formatToolSection(snap);
    if (toolSection !== undefined) sections.push(toolSection);
  }

  if (cfg.contextWindowEnabled && snap.context) {
    const total = formatTokens(snap.context.totalTokens);
    const percent =
      snap.context.totalTokens > 0
        ? ((snap.context.currentTokens / snap.context.totalTokens) * 100).toFixed(1)
        : "0.0";
    // Compact display: `31.4%/100K` (percent of window over abbreviated total).
    sections.push(`🪟 \`${percent}%/${total}\``);
  }

  if (cfg.compactionsEnabled) {
    sections.push(`🗑️ \`${snap.compactions}\``);
  }

  return sections.join(" ｜ ");
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
