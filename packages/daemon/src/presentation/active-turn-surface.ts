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
 *  - live render: the current display plus the recorded notices is re-pushed
 *    immediately at fire time, so a banner lands mid-turn;
 *  - terminal render: notices are spliced into the composed body at their
 *    anchor positions (between committed prose segments) instead of being
 *    appended as one trailing block, so a notice that fired between two
 *    prose segments lands between them in the delivered message. When an
 *    anchor cannot be resolved — it exceeded the committed segment count, or
 *    the body's segment boundaries are not locatable — the notice falls back
 *    to the end-of-body block; it is never dropped.
 *
 * Mirrors the singleton-map pattern used by `sessions/steer-channel.ts`.
 */

/** Accepts one banner/notice line to fold into the in-flight turn output. */
export type ActiveTurnNoticeSink = (notice: string) => void;

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
   * Live render: `display` plus the recorded notices appended as one block.
   * The live display cannot know final segment boundaries mid-stream, so it
   * keeps the legacy append-at-tail shape; the terminal render splices
   * chronologically instead.
   */
  readonly liveBody: (display: string) => string;
  /**
   * Terminal render: splice the recorded notices into `body` at their anchor
   * positions. `segments` are the turn's committed prose segments, in order
   * (the split of the turn's composed prose). Falls back to appending the
   * whole block at the end of `body` when anchors cannot be resolved.
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
 * Locates the block index of each prose segment, in order. A block matches a
 * segment when it IS the segment (exact, preferred) or when it ends with the
 * segment (a decoration like the agent identity prefix glued onto the same
 * block). Returns undefined when any segment cannot be located — the body
 * was rewritten away from the composed prose (e.g. a mid-stream failover
 * hop), so anchor positions are unresolvable.
 */
function locateSegmentBlocks(body: string, segments: readonly string[]): number[] | undefined {
  const blocks = splitBlocks(body);
  const result: number[] = [];
  let cursor = 0;
  for (const segment of segments) {
    let found = -1;
    for (let index = cursor; index < blocks.length; index += 1) {
      const block = blocks[index]!.trim();
      if (block === segment) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      for (let index = cursor; index < blocks.length; index += 1) {
        const block = blocks[index]!.trim();
        if (block.endsWith(segment)) {
          found = index;
          break;
        }
      }
    }
    if (found < 0) return undefined;
    result.push(found);
    cursor = found + 1;
  }
  return result;
}

const zeroAnchor = (): TurnNoticeAnchor => ({ committedProseSegments: 0, toolCalls: 0 });

/**
 * Creates a per-turn banner collector. The runner provides anchor capture
 * from its live state and, optionally, a live re-push hook (`onNotice`).
 */
export function createTurnBannerCollector(
  options: TurnBannerCollectorOptions,
): TurnBannerCollector {
  const notices: BannerEntry[] = [];
  const noticeBlock = (): string => notices.map((entry) => entry.notice).join("\n\n");
  return {
    add(notice) {
      notices.push({ notice, anchor: options.captureAnchor() });
      options.onNotice?.(notice);
    },
    liveBody(display) {
      return notices.length ? `${display}\n\n${noticeBlock()}` : display;
    },
    terminalBody(body, { segments }) {
      if (notices.length === 0) return body;
      const proseSegments = segments.filter((segment) => segment.trim().length > 0);
      if (proseSegments.length === 0) {
        // No prose segments to anchor against (tool-only turn, error body):
        // one block at the end of the body — the legacy placement.
        return `${body}\n\n${noticeBlock()}`;
      }
      const segmentBlockIndexes = locateSegmentBlocks(body, proseSegments);
      if (!segmentBlockIndexes) {
        // Unresolvable anchors: keep the legacy placement — one block at the
        // end of the body. Never drop a notice.
        return `${body}\n\n${noticeBlock()}`;
      }
      // Group notices by their clamped slot: slot s = after the s-th
      // committed prose segment (s=0 → before the first segment; s=K → at
      // the end of the body). Firing order is preserved within a slot.
      const bySlot = new Map<number, string[]>();
      for (const entry of notices) {
        const slot = Math.max(
          0,
          Math.min(entry.anchor.committedProseSegments, proseSegments.length),
        );
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
    },
  };
}

export type ActiveTurnSurfaceInput =
  | TurnBannerCollector
  | TurnBannerCollectorOptions
  | ActiveTurnNoticeSink;

/**
 * Normalizes a registered surface to a collector. The legacy sink form
 * `(notice) => void` is kept for backward compatibility: it receives every
 * notice as it is recorded, with a zero anchor (no positional splicing).
 * A ready-made collector is passed through unchanged (the runner keeps owning
 * it for terminal rendering after unregister).
 */
function toCollector(surface: ActiveTurnSurfaceInput): TurnBannerCollector {
  if (typeof surface === "function") {
    return createTurnBannerCollector({
      captureAnchor: zeroAnchor,
      onNotice: surface,
    });
  }
  if (typeof (surface as TurnBannerCollector).add === "function") {
    return surface as TurnBannerCollector;
  }
  return createTurnBannerCollector(surface as TurnBannerCollectorOptions);
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
