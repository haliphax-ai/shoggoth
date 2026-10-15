/**
 * Formatting-state tracking for streamed/partial Discord markdown.
 *
 * Extracted from `split-message.ts` so both the message splitter and the
 * streaming status-bar guard can share one definition of "is a formatting
 * construct still open at the end of this text?".
 */

/**
 * Paired inline formatting markers tracked across chunk boundaries.
 * Order matters: longer markers must come first so `**` is matched before `*`.
 */
export const INLINE_MARKERS = ["**", "__", "~~", "||", "*"] as const;

/** Matches a fenced-code opening line: three or more backticks plus an optional language tag. */
const FENCE_OPEN_RE = /^(`{3,})(\S*)/;

/** Formatting constructs open at a position within the text. */
export interface OpenFormattingState {
  /** Non-empty when inside a fenced code block; holds the full opening fence line (e.g. "```ts"). */
  readonly openFence: string;
  /** Inline markers open (toggled an odd number of times) outside fences. Empty while inside a fence. */
  readonly openInline: readonly string[];
}

/** No formatting constructs open. */
export const CLOSED_FORMATTING: OpenFormattingState = { openFence: "", openInline: [] };

/** Word character for underscore boundary checks (letters, digits, underscore). */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD_CHAR_RE.test(ch);
const isSpaceChar = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Determine which inline markers are "open" at the end of `raw`, starting
 * from `prevOpen` state.
 *
 * Only counts markers that appear outside of fenced code blocks.
 *
 * `**`, `*`, `__`, `~~`, and `||` are counted by parity. A single `_` is
 * tracked separately with Discord's asymmetric word-boundary rule: it OPENS
 * only when preceded by a non-word boundary (or line start) and followed by
 * non-whitespace, and CLOSES only when preceded by non-whitespace and
 * followed by a non-word boundary (or line end). This keeps intra-word
 * underscores (`snake_case_name`) from ever counting as formatting — even an
 * odd count of them — while still closing `_italic` before it can bleed into
 * a trailing status bar. A lone closer-side `_` (e.g. `word_`) opens nothing
 * and is ignored, matching Discord's literal rendering.
 */
export function computeOpenInlineMarkers(
  raw: string,
  prevOpen: readonly string[],
  prevOpenFence: string,
): string[] {
  const toggleCounts = new Map<string, number>();
  for (const m of prevOpen) {
    if (m !== "_") toggleCounts.set(m, 1);
  }
  let underscoreOpen = prevOpen.includes("_");

  let inFence = prevOpenFence !== "";

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (inFence) {
      if (trimmed.startsWith("```") && trimmed.replace(/`/g, "").trim() === "") {
        inFence = false;
      }
      continue;
    }
    const m = trimmed.match(FENCE_OPEN_RE);
    if (m && m[1].length >= 3) {
      inFence = true;
      continue;
    }

    // Count inline marker occurrences in this line.
    let pos = 0;
    while (pos < line.length) {
      // Skip inline code spans.
      if (line[pos] === "`") {
        pos++;
        while (pos < line.length && line[pos] !== "`") pos++;
        if (pos < line.length) pos++; // skip closing backtick
        continue;
      }

      let matched = false;
      for (const marker of INLINE_MARKERS) {
        if (line.startsWith(marker, pos)) {
          toggleCounts.set(marker, (toggleCounts.get(marker) ?? 0) + 1);
          pos += marker.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Single "_" — boundary-aware, per the rule documented above.
      if (line[pos] === "_") {
        const prevCh = pos > 0 ? line[pos - 1] : undefined;
        const nextCh = pos + 1 < line.length ? line[pos + 1] : undefined;
        if (!underscoreOpen) {
          // Opens only at a preceding word boundary with content after.
          if (!isWordChar(prevCh) && !isSpaceChar(nextCh)) underscoreOpen = true;
        } else {
          // Closes only with content before and a following word boundary.
          if (!isSpaceChar(prevCh) && !isWordChar(nextCh)) underscoreOpen = false;
        }
      }
      pos++;
    }
  }

  // Markers with odd toggle count are "open".
  const open: string[] = [];
  for (const marker of INLINE_MARKERS) {
    const c = toggleCounts.get(marker) ?? 0;
    if (c % 2 === 1) open.push(marker);
  }
  if (underscoreOpen) open.push("_");
  return open;
}

/**
 * Compute the formatting state open at the end of `raw`, starting from `prev`.
 */
export function computeOpenFormatting(
  raw: string,
  prev: OpenFormattingState = CLOSED_FORMATTING,
): OpenFormattingState {
  let inFence = prev.openFence !== "";
  let fenceTag = prev.openFence;

  // Scan lines for fence toggles.
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (inFence) {
      // Check for closing fence.
      if (trimmed.startsWith("```") && trimmed.replace(/`/g, "").trim() === "") {
        inFence = false;
        fenceTag = "";
      }
    } else {
      const m = trimmed.match(FENCE_OPEN_RE);
      if (m && m[1].length >= 3) {
        inFence = true;
        fenceTag = m[2] ? `\`\`\`${m[2]}` : "```";
      }
    }
  }

  // Inline markers — only relevant outside code fences (inside a fence they are
  // literal text, so an "open" pair there must not be synthetic-closed).
  const openInline = inFence ? [] : computeOpenInlineMarkers(raw, prev.openInline, prev.openFence);
  return { openFence: inFence ? fenceTag : "", openInline };
}

/**
 * Suffix that closes every construct open at the end of `raw`, plus the
 * resulting state to carry into the next chunk.
 */
export function computeChunkClose(
  raw: string,
  prev: OpenFormattingState = CLOSED_FORMATTING,
): { suffix: string; state: OpenFormattingState } {
  const state = computeOpenFormatting(raw, prev);

  let suffix = "";
  if (state.openInline.length > 0) {
    // Close open inline markers (reverse order).
    suffix += [...state.openInline].reverse().join("");
  }
  if (state.openFence) {
    // Close open fence on its own line unless the content already ends with one.
    suffix += (suffix || raw.endsWith("\n") ? "" : "\n") + "```";
  }

  return { suffix, state };
}

/** Prefix that reopens the formatting carried from the previous chunk. */
export function buildReopenPrefix(state: OpenFormattingState): string {
  let prefix = "";
  if (state.openFence) prefix += state.openFence + "\n";
  if (state.openInline.length > 0) prefix += state.openInline.join("");
  return prefix;
}

/**
 * Close any formatting constructs left open at the end of `text` with
 * synthetic markers so the rendered output cannot leak into whatever follows
 * it (e.g. the turn status bar).
 *
 * - Unclosed inline markers (`*`, `**`, `__`, `~~`, `||`, and boundary-aware
 *   `_`) get their closing marker appended. When a later chunk completes the
 *   pair, the marker count becomes even again and the synthetic close
 *   disappears on its own. Single `_` only counts at word boundaries
 *   (Discord's asymmetric rule), so intra-word underscores in prose such as
 *   `snake_case_name` never trigger a synthetic close.
 * - An unclosed fenced block gets a closing ``` (the fence swallows everything
 *   after it, including the bar, until closed).
 * - Inside a fenced block, inline markers are literal text and are ignored,
 *   per the fence-only rule.
 *
 * Returns `text` unchanged when every construct is closed.
 */
export function appendSyntheticClose(text: string): string {
  const { suffix } = computeChunkClose(text);
  return suffix === "" ? text : text + suffix;
}
