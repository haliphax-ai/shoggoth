/**
 * Active turn surface registry + unified banner manager for in-turn banners:
 * banners that belong to an in-flight turn must land in the turn's active output
 * instead of separate channel messages. The turn runner registers a per-turn
 * {@link TurnBannerCollector} for its session; producers call
 * `postTurnSurfaceNotice` and fall back to `sendStatusMessage` only when no
 * surface is registered. Full model (anchors, splicing, single-render guarantee):
 * docs/daemon.md, "Turn Output Presentation".
 */

/** The turn position at which a notice fired. */
export interface TurnNoticeAnchor {
  /** Committed (settled) prose segments before this notice fired. */
  readonly committedProseSegments: number;
  /** Tool calls executed before this notice fired. */
  readonly toolCalls: number;
}

interface BannerEntry {
  readonly notice: string;
  readonly anchor: TurnNoticeAnchor;
}

export interface TurnBannerCollectorOptions {
  /** Runner-side capture of the turn's position at fire time. */
  readonly captureAnchor: () => TurnNoticeAnchor;
  /**
   * Called right after a notice is recorded so the runner can re-push the
   * live display. Receives the recorded notice.
   */
  readonly onNotice?: (notice: string) => void;
}

export interface TurnBannerCollector {
  /** Record a notice with the current anchor. */
  readonly add: (notice: string) => void;
  /**
   * Live render: splice the recorded notices into `display` at their anchor
   * positions — the same slot semantics as {@link terminalBody}, so the
   * in-flight message shows each notice between the prose segments it fired
   * between. `segments` are the display's committed prose segments in order
   * (the runner's settled prose so far; the round still streaming is not
   * among them). Falls back to appending the block at the tail when anchors
   * cannot be resolved. Re-renders from scratch on every push.
   */
  readonly liveBody: (display: string, opts: { readonly segments: readonly string[] }) => string;
  /**
   * Terminal render: splice the recorded notices into `body` at their anchor
   * positions. `segments` are the turn's committed prose segments, in order
   * (the split of the turn's composed prose). Falls back to appending the
   * whole block at the end of `body` when anchors cannot be resolved. Each
   * body renders at most once — see docs/daemon.md (Turn Output Presentation).
   */
  readonly terminalBody: (body: string, opts: { readonly segments: readonly string[] }) => string;
}

/**
 * Splits a composed body into the markdown blocks separated by blank lines.
 * Blocks are the natural insertion units for notices (each notice renders as
 * its own blockquote block); the rendered turn body — prose segments,
 * thinking quotes, and decorations — is exactly such a block sequence.
 */
const splitBlocks = (body: string): string[] => body.split(/\n\n+/);

/**
 * Locates, for each prose segment in order, the block index of the segment's
 * LAST block — the insertion point for a notice anchored "after this segment".
 * Segments are round-sized and may span several blocks, so each paragraph of a
 * segment is located individually (exact block match preferred, then a block
 * ending with the paragraph), forward in order. Returns undefined when any
 * paragraph cannot be located (the body was rewritten away from the composed
 * prose, e.g. a mid-stream failover hop). Details: docs/daemon.md (Turn Output
 * Presentation).
 */
function locateSegmentBlocks(body: string, segments: readonly string[]): number[] | undefined {
  const blocks = splitBlocks(body);
  const result: number[] = [];
  let cursor = 0;
  for (const segment of segments) {
    // Multi-paragraph segments are located paragraph by paragraph; a
    // single-paragraph segment degenerates to exactly the block lookup
    // (exact, then endsWith) this has always done.
    const paragraphs = segment.split(/\n\n+/);
    let lastFound = -1;
    for (const paragraph of paragraphs) {
      // A raw (un-normalized) segment can end with a blank line, yielding a
      // trailing empty paragraph — it must not consume the next block.
      if (!paragraph) continue;
      let found = -1;
      for (let index = cursor; index < blocks.length; index += 1) {
        const block = blocks[index]!.trim();
        if (block === paragraph) {
          found = index;
          break;
        }
      }
      if (found < 0) {
        for (let index = cursor; index < blocks.length; index += 1) {
          const block = blocks[index]!.trim();
          if (block.endsWith(paragraph)) {
            found = index;
            break;
          }
        }
      }
      if (found < 0) return undefined;
      lastFound = found;
      cursor = found + 1;
    }
    // The LAST block of the segment's run: a notice anchored after this
    // segment must land after its final paragraph, never inside it.
    result.push(lastFound);
  }
  return result;
}

/**
 * Creates a per-turn banner collector. The runner provides anchor capture
 * from its live state and, optionally, a live re-push hook (`onNotice`).
 * Both render paths run the SAME splice helper, so the live stream and the
 * delivered body can never disagree on where a notice lands.
 */
export function createTurnBannerCollector(
  options: TurnBannerCollectorOptions,
): TurnBannerCollector {
  const notices: BannerEntry[] = [];
  // The ONE placement rule: slot s = after the s-th committed prose segment
  // (s=0 → before the first block; s=K → at the end), clamped, order kept;
  // unresolvable anchors fall back to one trailing block.
  const splice = (body: string, segments: readonly string[]): string => {
    if (notices.length === 0) return body;
    const noticeBlock = notices.map((entry) => entry.notice).join("\n\n");
    const proseSegments = segments.filter((segment) => segment.trim().length > 0);
    const trailing = (target: string): string =>
      target ? `${target}\n\n${noticeBlock}` : noticeBlock;
    if (proseSegments.length === 0) {
      // No prose segments to anchor against (tool-only turn, error body,
      // pre-prose live placeholder): one block at the end of the body.
      return trailing(body);
    }
    const segmentBlockIndexes = locateSegmentBlocks(body, proseSegments);
    if (!segmentBlockIndexes) {
      // Unresolvable anchors: keep the legacy placement — one block at the
      // end of the body. Never drop a notice.
      return trailing(body);
    }
    // Group notices by clamped slot, order preserved; s>K clamps to K
    // (trailing, like the fallbacks), s==K fired at the last round boundary
    // and is chronologically trailing (after the final segment).
    const bySlot = new Map<number, string[]>();
    for (const entry of notices) {
      const slot = Math.max(0, Math.min(entry.anchor.committedProseSegments, proseSegments.length));
      const group = bySlot.get(slot);
      if (group) group.push(entry.notice);
      else bySlot.set(slot, [entry.notice]);
    }
    const blocks = splitBlocks(body);
    const insertAt = new Map<number, string[]>();
    for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
      const afterIndex =
        slot <= 0
          ? -1
          : slot >= proseSegments.length
            ? blocks.length - 1
            : segmentBlockIndexes[slot - 1]!;
      const at = afterIndex + 1;
      const group = bySlot.get(slot)!;
      insertAt.set(at, (insertAt.get(at) ?? []).concat(group));
    }
    const out: string[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const extra = insertAt.get(index);
      if (extra) out.push(...extra);
      out.push(blocks[index]!);
    }
    const tailExtra = insertAt.get(blocks.length);
    if (tailExtra) out.push(...tailExtra);
    return out.join("\n\n");
  };

  // Terminal renders are memoized per body: a re-run of the termination
  // sequence against the delivered body can never splice a second
  // (bottom-smashed) layout; a distinct body still gets its own single render.
  const terminalRenders = new Map<string, string>();

  return {
    add(notice) {
      notices.push({ notice, anchor: options.captureAnchor() });
      options.onNotice?.(notice);
    },
    liveBody(display, { segments }) {
      return splice(display, segments);
    },
    terminalBody(body, { segments }) {
      const rendered = terminalRenders.get(body);
      if (rendered !== undefined) return rendered;
      const final = splice(body, segments);
      terminalRenders.set(body, final);
      return final;
    },
  };
}

export type ActiveTurnSurfaceInput = TurnBannerCollector | TurnBannerCollectorOptions;

/**
 * Normalizes a registered surface to a collector: a ready-made collector is
 * passed through unchanged (the runner keeps owning it for terminal rendering
 * after unregister), and an options object is wrapped in a fresh collector.
 */
function toCollector(surface: ActiveTurnSurfaceInput): TurnBannerCollector {
  if ("add" in surface) {
    return surface;
  }
  return createTurnBannerCollector(surface);
}

const surfaces = new Map<string, TurnBannerCollector>();

/**
 * Register the active turn's banner collector for a session. The turn runner
 * calls this when the turn's output surface becomes live and unregisters in
 * its teardown path; a later turn's registration replaces an earlier one.
 * The collector object stays owned by the runner (which may keep using it
 * for terminal rendering even after unregister — e.g. detached delivery), so
 * notices are never lost between unregister and a deferred final compose.
 */
export function registerActiveTurnSurface(
  sessionId: string,
  surface: ActiveTurnSurfaceInput,
): { unregister: () => void } {
  const collector = toCollector(surface);
  surfaces.set(sessionId, collector);
  return {
    unregister: () => {
      if (surfaces.get(sessionId) === collector) surfaces.delete(sessionId);
    },
  };
}

/**
 * Append a notice to the session's active turn output.
 * Returns false when no surface is registered (or the sink threw), so the
 * caller can fall back to posting a standalone status message.
 */
export function postTurnSurfaceNotice(sessionId: string, notice: string): boolean {
  const collector = surfaces.get(sessionId);
  if (!collector) return false;
  try {
    collector.add(notice);
    return true;
  } catch {
    return false;
  }
}

/** Visible for testing — clears all registered surfaces. */
export function _resetActiveTurnSurfaces(): void {
  surfaces.clear();
}
