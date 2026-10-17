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
  /** Inline markers still open at the end of the scanned text (outside fences). Empty while inside a fence. */
  readonly openInline: readonly string[];
}

/** No formatting constructs open. */
export const CLOSED_FORMATTING: OpenFormattingState = { openFence: "", openInline: [] };

/** Word character for underscore boundary checks (letters, digits, underscore). */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD_CHAR_RE.test(ch);
const isSpaceChar = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Every tracked marker: the paired markers plus the boundary-aware single
 * `_`. Order matters for scanning (longer markers must match first) and for
 * the canonical open/close ordering (`_` closes last, matching how the
 * reopen prefix and the chunk-close suffix are built).
 */
const TRACKED_MARKERS: readonly string[] = [...INLINE_MARKERS, "_"];

/**
 * A marker may only OPEN formatting at Discord's opener boundary: preceded
 * by a word boundary (or line start) and followed by non-whitespace.
 * Spoilers (`||`) forgo the word boundary and only need content after them.
 */
const canOpenMarker = (
  marker: string,
  prevCh: string | undefined,
  nextCh: string | undefined,
): boolean => {
  if (marker === "||") return !isSpaceChar(nextCh); // spoilers: content-side only
  return !isWordChar(prevCh) && !isSpaceChar(nextCh);
};

/**
 * A marker may only CLOSE open formatting at Discord's closer boundary:
 * preceded by non-whitespace and followed by a word boundary (or line end).
 * Spoilers only need content immediately before the closing marker.
 */
const canCloseMarker = (
  marker: string,
  prevCh: string | undefined,
  nextCh: string | undefined,
): boolean => {
  if (marker === "||") return !isSpaceChar(prevCh); // spoilers: content-side only
  return !isSpaceChar(prevCh) && !isWordChar(nextCh);
};

/**
 * Determine which inline markers are "open" at the end of `raw`, starting
 * from `prevOpen` state.
 *
 * Only markers outside of fenced code blocks are tracked.
 *
 * The chunk is scanned as a viewer sees it: the reopen prefix built from
 * `prevOpen` is prepended to `raw` before scanning, so markers at the very
 * start of a chunk get their true surrounding context (a hard split can land
 * right before a closing marker, where the prefix supplies the preceding
 * content).
 *
 * A marker toggles only at positions where Discord can actually format:
 *
 * - it OPENS only when preceded by a word boundary (or line start) and
 *   followed by non-whitespace;
 * - it CLOSES only when preceded by non-whitespace and followed by a word
 *   boundary (or line end).
 *
 * This is the asymmetric word-boundary rule that already applied to a
 * single `_`; extending it to `**`, `*`, `__`, and `~~` keeps intra-word
 * and word-end markers (`5 * 3`, `ends with *`, `snake_case_name`) from
 * counting as toggles — an unpaired marker there is literal text in Discord,
 * and appending its companion would corrupt later text that legitimately
 * uses the marker. Spoilers (`||`) are the exception: Discord formats them
 * with no word boundary at all (`foo||bar||baz`), so each marker only
 * requires content on its inside (non-whitespace after an opener, before a
 * closer).
 */
export function computeOpenInlineMarkers(
  raw: string,
  prevOpen: readonly string[],
  prevOpenFence: string,
): string[] {
  // Rescan the chunk as rendered: the reopen prefix built from `prevOpen` is
  // part of the visible text and supplies the boundary context for markers
  // at the start of `raw`.
  const text = prevOpen.join("") + raw;

  const open = new Set<string>();
  let inFence = prevOpenFence !== "";

  const lines = text.split("\n");
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

    // Scan inline markers in this line with Discord's boundary rules.
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
      for (const marker of TRACKED_MARKERS) {
        if (line.startsWith(marker, pos)) {
          const prevCh = pos > 0 ? line[pos - 1] : undefined;
          const nextCh = pos + marker.length < line.length ? line[pos + marker.length] : undefined;
          if (open.has(marker)) {
            if (canCloseMarker(marker, prevCh, nextCh)) open.delete(marker);
          } else if (canOpenMarker(marker, prevCh, nextCh)) {
            open.add(marker);
          }
          pos += marker.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      pos++;
    }
  }

  // Canonical order: INLINE_MARKERS order, then "_".
  return TRACKED_MARKERS.filter((marker) => open.has(marker));
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
 * - Unclosed inline markers get their closing marker appended. A marker is
 *   only tracked where Discord would actually format it — at its opener or
 *   closer word boundary — so intra-word and word-end markers in prose
 *   (`5 * 3`, `snake_case_name`, a trailing `*`) never trigger a synthetic
 *   close. When a later chunk completes the pair, the synthetic close
 *   disappears on its own.
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
