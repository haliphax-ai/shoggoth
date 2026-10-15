import { DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS } from "./errors";
import {
  buildReopenPrefix,
  computeChunkClose,
  type OpenFormattingState,
  CLOSED_FORMATTING,
} from "./formatting-state";

/**
 * Split a Discord message into chunks that each fit within `maxLength`.
 *
 * Splitting priority: newline → space → hard-cut.
 *
 * Fenced code blocks (triple backticks with optional language tag) are tracked:
 * if a chunk ends inside a code block the chunk is closed with ``` and the next
 * chunk reopens with the same fence (including language tag).
 *
 * Paired inline formatting markers (`**`, `*`, `__`, `~~`, `||`) that are opened
 * but not closed within a chunk are closed at the end and reopened at the start
 * of the next chunk.
 *
 * Formatting state is tracked via the shared helpers in `formatting-state.ts`.
 */
export function splitDiscordMessage(
  text: string,
  maxLength: number = DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS,
): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openState: OpenFormattingState = CLOSED_FORMATTING;

  while (remaining.length > 0) {
    // Build a prefix that reopens any formatting state carried from the previous chunk.
    const prefix = buildReopenPrefix(openState);
    const budget = maxLength - prefix.length;

    if (budget <= 0) {
      // Degenerate: maxLength too small to fit even the prefix. Hard-cut to avoid infinite loop.
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
      continue;
    }

    if (remaining.length <= budget) {
      chunks.push(prefix + remaining);
      break;
    }

    // Find a split point within budget.
    let splitAt = findSplitPoint(remaining, budget);

    // Reserve room for a closing suffix (fence + inline markers).
    const closeSuffix = computeChunkClose(remaining.slice(0, splitAt), openState).suffix;
    if (splitAt + closeSuffix.length > budget) {
      // Recalculate with reduced budget.
      splitAt = findSplitPoint(remaining, budget - closeSuffix.length);
    }

    const raw = remaining.slice(0, splitAt);
    // Recalculate close suffix for the actual raw content (fence state may differ).
    const { suffix, state } = computeChunkClose(raw, openState);

    chunks.push(prefix + raw + suffix);
    remaining = remaining.slice(splitAt);
    openState = state;
  }

  return chunks;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function findSplitPoint(text: string, budget: number): number {
  if (text.length <= budget) return text.length;

  // Prefer newline boundary.
  const newlineIdx = text.lastIndexOf("\n", budget - 1);
  if (newlineIdx > 0) return newlineIdx + 1; // include the newline in this chunk

  // Then space boundary.
  const spaceIdx = text.lastIndexOf(" ", budget - 1);
  if (spaceIdx > 0) return spaceIdx + 1;

  // Hard-cut.
  return budget;
}
