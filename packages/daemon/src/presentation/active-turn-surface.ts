/**
 * Active turn surface registry + unified banner manager for in-turn banners.
 *
 * Banners that belong to an in-flight turn — the session-send yield notice,
 * the "delivered in-turn" traces for exec / session-send notifications — must
 * land IN the turn's active output instead of being posted as separate
 * channel messages. The turn runner creates a per-turn {@link
 * TurnBannerCollector} and registers it for its session while the turn is
 * live; producers call `postTurnSurfaceNotice` and fall back to
 * `sendStatusMessage` only when no surface is registered (no live turn
 * output: OOB/internal turns, bare test harnesses).
 *
 * The collector owns both capture and rendering of notices:
 *  - capture: notices are recorded with an anchor captured from the runner's
 *    live state at fire time (`{ committedProseSegments, toolCalls }`);
 *  - live render: on every push the current display is re-rendered FROM
 *    SCRATCH with the recorded notices spliced in at their anchors — the
 *    banner lands mid-turn, in chronological position, not pinned to the
 *    tail of the streamed message;
 *  - terminal render: the same splice runs against the composed body at
 *    delivery, so the live stream and the delivered message place each
 *    notice between the prose segments it fired between. Each body renders
 *    at most once — the delivered body's first render is the final one and
 *    later calls return it untouched — so termination can never produce an
 *    intermediate layout or render the delivered body more than once.
 *
 * Both renders share one splice helper: slot s = after the s-th committed
 * prose segment (s=0 → before the first block; s=K → at the end), clamped to
 * the segment list the caller passes, firing order preserved within a slot.
 * When an anchor cannot be resolved — it exceeded the committed segment
 * count, or the body's segment boundaries are not locatable — the notices
 * fall back to the end-of-body block; they are never dropped and never throw
 * mid-stream.
 *
 * Mirrors the singleton-map pattern used by `sessions/steer-channel.ts`.
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
   * whole block at the end of `body` when anchors cannot be resolved.
   *
   * Renders each body at most once: the first render of `body` is the final
   * one — calling again with that same body returns it untouched, so a
   * re-run of the termination sequence can never produce a second (or
   * bottom-smashed) layout for the delivered body. A distinct body (e.g.
   * the error body after a failed delivery) gets its own single render.
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
 * LAST block — the insertion point for a notice anchored "after this
 * segment".
 *
 * Segments are round-sized: a round's content can contain blank lines (the
 * model narrates multi-paragraph chunks like "Raw spec:\n\n<paragraph>"), so
 * a segment may span several blocks after `splitBlocks`. Each PARAGRAPH of a
 * segment is therefore located individually: a paragraph matches a block
 * when it IS the block (exact, preferred) or when the block ends with it (a
 * decoration like the agent identity prefix glued onto the same block), and
 * the paragraphs are located forward in order so the segment's block run is
 * contiguous in the block list. Returns undefined when any paragraph cannot
 * be located — the body was rewritten away from the composed prose (e.g. a
 * mid-stream failover hop), so anchor positions are unresolvable.
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
  // (s=0 → before the first block; s=K → at the end), clamped to the segment
  // count, firing order preserved within a slot. Falls back to one trailing
  // block when anchors cannot be resolved (no prose segments, or the segment
  // boundaries are not locatable in `body`) — a notice is never dropped and
  // this never throws.
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
    // Group notices by their clamped slot: slot s = after the s-th
    // committed prose segment (s=0 → before the first segment; s=K → at
    // the end of the body). Firing order is preserved within a slot.
    //
    // EXPLICIT semantics for the two tail-adjacent slots:
    //  - s > K: the anchor exceeds the segment list — unresolvable, clamped
    //    to K (same trailing placement as the fallbacks above).
    //  - s == K: the notice fired at a round boundary that turned out to be
    //    the LAST one (a cancel banner firing after the trip hop's round
    //    settled, with no further prose committed). Chronologically this is
    //    a TRAILING notice and is placed after the final segment by
    //    definition — distinct from the unresolvable-locate fallback, which
    //    only fires when the body cannot be reconciled with the segments
    //    at all.
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

  // The terminal path renders each body at most once: the first render of a
  // body is memoized, so a re-run of the termination sequence against the
  // delivered body can never splice a second (bottom-smashed) layout — there
  // is no phase where the banners are dropped to the bottom — while a
  // distinct body (e.g. the error body after a failed delivery) still gets
  // its own single render.
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
