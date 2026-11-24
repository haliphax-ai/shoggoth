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

/** A backticks-only line (a run of three or more): closes an open fence. */
const isClosingFenceLine = (trimmed: string): boolean =>
  trimmed.startsWith("```") && trimmed.replace(/`/g, "").trim() === "";

/**
 * Opening fence tag when `trimmed` opens a fence (three or more backticks
 * plus an optional language tag); "" when it does not.
 */
const openedFenceTag = (trimmed: string): string => {
  const m = trimmed.match(FENCE_OPEN_RE);
  return m && m[1].length >= 3 ? (m[2] ? "```" + m[2] : "```") : "";
};

/**
 * Apply one line's fence rules to the fence state (`trimmed` is the line with
 * leading whitespace removed). Returns the updated state plus whether the
 * line is consumed by the fence logic — fence content, a closing fence, or an
 * opening fence — and therefore never reaches the inline-marker scan.
 */
function stepFenceState(
  inFence: boolean,
  tag: string,
  trimmed: string,
): { inFence: boolean; tag: string; isFenceLine: boolean } {
  if (inFence) {
    return isClosingFenceLine(trimmed)
      ? { inFence: false, tag: "", isFenceLine: true }
      : { inFence, tag, isFenceLine: true };
  }
  const openTag = openedFenceTag(trimmed);
  return openTag === ""
    ? { inFence, tag, isFenceLine: false }
    : { inFence: true, tag: openTag, isFenceLine: true };
}

/**
 * Resumable scan cursor for the fence-and-inline-marker pass. Fence rules
 * match the line-based scanner: a backticks-only ``` line closes an open
 * fence, a >=3-backtick line opens one, and fence lines skip the inline scan.
 */
interface ScanCursor {
  /** Whether the scan is inside a fenced code block. */
  inFence: boolean;
  /** Full opening fence line while inside a fence (e.g. "```ts"); "" otherwise. */
  fenceTag: string;
  /** Scan position: start of the first line not yet consumed. */
  pos: number;
  /** Inline markers currently open (outside fences), in discovery order. */
  open: Set<string>;
  /** True when the previous scan ended with an unterminated line (fragment). */
  midLine: boolean;
  /** Pre-fragment snapshot for rescanning an unterminated final line. */
  tailFence: boolean;
  tailTag: string;
  tailOpen: Set<string>;
}

const freshCursor = (): ScanCursor => ({
  inFence: false,
  fenceTag: "",
  pos: 0,
  open: new Set<string>(),
  midLine: false,
  tailFence: false,
  tailTag: "",
  tailOpen: new Set<string>(),
});

/** Open markers in canonical order (INLINE_MARKERS order, then "_"). */
const canonicalOpen = (open: Set<string>): string[] =>
  TRACKED_MARKERS.filter((marker) => open.has(marker));

/**
 * Scan one line's inline markers with Discord's boundary rules, toggling
 * membership in `open`. Fence lines never reach this: callers route them to
 * the fence-toggle logic instead.
 */
function scanInlineLine(line: string, open: Set<string>): void {
  let pos = 0;
  while (pos < line.length) {
    // Inline code spans are literal text: skip to the closing backtick.
    if (line[pos] === "`") {
      pos = skipInlineCode(line, pos);
      continue;
    }

    const marker = TRACKED_MARKERS.find((m) => line.startsWith(m, pos));
    if (marker === undefined) {
      pos++;
      continue;
    }
    toggleTrackedMarker(line, pos, marker, open);
    pos += marker.length;
  }
}

/** Advance past an inline code span whose opening backtick is at `pos`. */
function skipInlineCode(line: string, pos: number): number {
  pos++;
  while (pos < line.length && line[pos] !== "`") pos++;
  return pos < line.length ? pos + 1 : pos; // skip the closing backtick when present
}

/** Toggle `marker` at `pos` in `open` where Discord's boundary rules allow. */
function toggleTrackedMarker(line: string, pos: number, marker: string, open: Set<string>): void {
  const prevCh = pos > 0 ? line[pos - 1] : undefined;
  const nextCh = pos + marker.length < line.length ? line[pos + marker.length] : undefined;
  if (open.has(marker)) {
    if (canCloseMarker(marker, prevCh, nextCh)) open.delete(marker);
  } else if (canOpenMarker(marker, prevCh, nextCh)) {
    open.add(marker);
  }
}

/**
 * Consume `text` into the scan cursor; `text` must extend the text already
 * consumed. Only unconsumed lines are scanned, so the cost across growing
 * snapshots stays proportional to the appended text. Lines finalize only
 * once their newline arrives — an unterminated final line snapshots the
 * pre-line state and is rescanned from its line start on the next call, so
 * every line is scanned exactly once over its final content and the result
 * matches a single full scan of the concatenated text.
 */
function scanInto(cursor: ScanCursor, text: string): void {
  let { inFence, fenceTag, pos } = cursor;
  let open = cursor.open;

  if (cursor.midLine) {
    // The previous call scanned a trailing fragment; restore the state from
    // before that line so the fragment is rescanned from its line start.
    inFence = cursor.tailFence;
    fenceTag = cursor.tailTag;
    open = new Set(cursor.tailOpen);
  }
  cursor.midLine = false;

  let lineStart = pos;
  while (lineStart < text.length) {
    const newlineIdx = text.indexOf("\n", lineStart);
    const complete = newlineIdx !== -1;
    const lineEnd = complete ? newlineIdx : text.length;
    if (!complete) {
      // Unterminated final line: remember the pre-line state so the next call
      // can rescan the fragment from here.
      cursor.midLine = true;
      cursor.tailFence = inFence;
      cursor.tailTag = fenceTag;
      cursor.tailOpen = new Set(open);
    }
    const line = text.slice(lineStart, lineEnd);

    const step = stepFenceState(inFence, fenceTag, line.trimStart());
    inFence = step.inFence;
    fenceTag = step.tag;
    if (!step.isFenceLine) scanInlineLine(line, open);

    if (!complete) {
      pos = lineStart; // fragment: rescanned once its newline arrives
      break;
    }
    pos = lineEnd + 1;
    lineStart = pos;
  }

  cursor.inFence = inFence;
  cursor.fenceTag = fenceTag;
  cursor.pos = pos;
  cursor.open = open;
}

/**
 * Determine which inline markers are "open" at the end of `raw`, starting
 * from `prevOpen` state (markers outside fenced code blocks only). The chunk
 * is scanned as a viewer sees it — the reopen prefix built from `prevOpen`
 * is prepended to `raw` first, so start-of-chunk markers get their true
 * context. A marker toggles only where Discord can actually format: OPENS
 * at a word boundary before non-whitespace, CLOSES after non-whitespace at
 * a word boundary; spoilers (`||`) need only inside content. Details:
 * docs/platform-discord.md ("Message Splitting").
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

  for (const line of text.split("\n")) {
    const step = stepFenceState(inFence, "", line.trimStart());
    inFence = step.inFence;
    if (!step.isFenceLine) scanInlineLine(line, open);
  }

  // Canonical order: INLINE_MARKERS order, then "_".
  return TRACKED_MARKERS.filter((marker) => open.has(marker));
}

/** Fence walk over complete lines: toggle state, keep the last opened tag. */
function walkFences(
  raw: string,
  inFenceStart: boolean,
  tagStart: string,
): { inFence: boolean; tag: string } {
  let inFence = inFenceStart;
  let tag = tagStart;
  for (const line of raw.split("\n")) {
    const step = stepFenceState(inFence, tag, line.trimStart());
    inFence = step.inFence;
    tag = step.tag;
  }
  return { inFence, tag };
}

/**
 * Compute the formatting state open at the end of `raw`, starting from `prev`.
 */
export function computeOpenFormatting(
  raw: string,
  prev: OpenFormattingState = CLOSED_FORMATTING,
): OpenFormattingState {
  if (prev === CLOSED_FORMATTING) {
    // Direct scan of the whole text from nothing — the common one-shot path.
    const cursor = freshCursor();
    scanInto(cursor, raw);
    return {
      openFence: cursor.inFence ? cursor.fenceTag : "",
      openInline: cursor.inFence ? [] : canonicalOpen(cursor.open),
    };
  }

  // Chunked path: the reopen prefix built from `prev` is part of the rendered
  // chunk, so fence toggles and inline markers are scanned with that prefix in
  // mind (see `computeOpenInlineMarkers` for the prepend discipline).
  const { inFence, tag } = walkFences(raw, prev.openFence !== "", prev.openFence);
  const openInline = inFence ? [] : computeOpenInlineMarkers(raw, prev.openInline, prev.openFence);
  return { openFence: inFence ? tag : "", openInline };
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
 * it (e.g. the turn status bar). Unclosed inline markers get their closing
 * marker appended; an unclosed fenced block gets a closing ```; inside a
 * fence, inline markers are literal text and are ignored. Returns `text`
 * unchanged when every construct is closed. Details:
 * docs/platform-discord.md ("Message Splitting").
 */
export function appendSyntheticClose(text: string): string {
  const { suffix } = computeChunkClose(text);
  return suffix === "" ? text : text + suffix;
}

/**
 * Incremental variant of `appendSyntheticClose` for streaming callers that
 * push growing snapshots of the same message. Feed every snapshot through the
 * returned closer: when the snapshot extends the previously closed one, only
 * the lines not yet scanned are processed; any other input (reset, shortened
 * text, new message) falls back to a full rescan. Output is identical to
 * `appendSyntheticClose` for every input.
 */
export function createIncrementalSyntheticClose(): (text: string) => string {
  let base = "";
  let cursor = freshCursor();

  return (text: string) => {
    // Resume the cursor only when the snapshot extends the previously closed
    // one; otherwise restart the scan from scratch.
    if (!text.startsWith(base)) cursor = freshCursor();
    scanInto(cursor, text);
    base = text;

    let suffix = "";
    if (cursor.inFence) {
      // Close open fence on its own line unless the content already ends with one.
      suffix += (text.endsWith("\n") ? "" : "\n") + "```";
    } else {
      // Close open inline markers (reverse order).
      suffix += canonicalOpen(cursor.open).reverse().join("");
    }
    return suffix === "" ? text : text + suffix;
  };
}
