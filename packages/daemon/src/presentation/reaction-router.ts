// reaction-router.ts — pure reaction routing logic (no external Shoggoth imports)

export interface ReactionLegendEntry {
  readonly emoji: string;
  readonly label: string;
}

export interface ParsedReactionLegend {
  readonly entries: readonly ReactionLegendEntry[];
}

const LEGEND_HEADER_RE = /^react to choose:\s*$/im;

/**
 * Parse a reaction legend block from message content.
 * Legend starts with a line matching "React to choose:" (case-insensitive)
 * and each subsequent line is `<emoji> <label>` until a blank line or end of message.
 * Returns null if no legend found.
 */
export function parseReactionLegend(messageContent: string): ParsedReactionLegend | null {
  const match = LEGEND_HEADER_RE.exec(messageContent);
  if (!match) return null;

  const afterHeader = messageContent.slice(match.index + match[0].length);
  const lines = afterHeader.split("\n");
  const entries: ReactionLegendEntry[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) break; // blank line terminates the block

    // First token is the emoji, rest is the label
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) {
      // Line with emoji only — no label; still a valid entry with empty label
      entries.push({ emoji: line, label: "" });
    } else {
      const emoji = line.slice(0, spaceIdx);
      const label = line.slice(spaceIdx + 1).trim();
      entries.push({ emoji, label });
    }
  }

  if (entries.length === 0) return null;
  return { entries };
}

export type ReactionRouteResult =
  | { readonly kind: "adhoc"; readonly legend: ParsedReactionLegend; readonly selected: ReactionLegendEntry; readonly messageContent: string }
  | { readonly kind: "global"; readonly emoji: string; readonly messageContent: string }
  | { readonly kind: "discard"; readonly reason: string };

export interface ReactionRouteInput {
  readonly emoji: string;
  readonly messageContent: string;
  readonly messageTimestamp: number; // epoch ms
  readonly nowMs: number;
  readonly maxAgeMinutes: number;
  readonly globalPassthrough: readonly string[];
}

/**
 * Route a reaction through the age → legend → global → discard flow.
 *
 * 1. If message too old → discard
 * 2. If message has a legend and reaction matches a legend entry → adhoc
 * 3. If message has a legend and reaction does NOT match → discard (no fallthrough to global)
 * 4. If no legend and reaction is in global passthrough set → global
 * 5. If no legend and reaction is NOT in global set → discard
 */
export function routeReaction(input: ReactionRouteInput): ReactionRouteResult {
  const { emoji, messageContent, messageTimestamp, nowMs, maxAgeMinutes, globalPassthrough } = input;

  // 1. Age check
  const ageMs = nowMs - messageTimestamp;
  const maxAgeMs = maxAgeMinutes * 60_000;
  if (ageMs > maxAgeMs) {
    return { kind: "discard", reason: `message too old (${Math.round(ageMs / 60_000)}m > ${maxAgeMinutes}m)` };
  }

  // 2–3. Legend path
  const legend = parseReactionLegend(messageContent);
  if (legend) {
    const selected = legend.entries.find((e) => e.emoji === emoji);
    if (selected) {
      return { kind: "adhoc", legend, selected, messageContent };
    }
    return { kind: "discard", reason: "reaction not in legend" };
  }

  // 4–5. Global passthrough path
  if (globalPassthrough.includes(emoji)) {
    return { kind: "global", emoji, messageContent };
  }

  return { kind: "discard", reason: "no legend and emoji not in global passthrough" };
}
