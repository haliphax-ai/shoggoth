/**
 * In-turn event banners and delivery (issue #497).
 *
 * Async completions that land while the agent's turn is still running —
 * background exec notifications, async agent-to-agent replies, inline tool
 * results with truncated args — are delivered into the *current* turn through
 * the session's steer channel instead of spinning up an out-of-band turn.
 *
 * Display uses the familiar emoji-lead blockquote banner pattern (the same
 * aesthetic as the OOB turn banners in `oob-turn-banner.ts`): a `> emoji
 * Title: *detail* `id`` lead line followed by the event body. Builders are
 * platform-neutral and the strings are unit-tested.
 *
 * Delivery is guaranteed: `deliverInTurnEvent` falls back to the caller's
 * fallback path (typically the OOB turn) both when no turn is active *and*
 * when the turn ends before the queued event was drained — the steer channel
 * invokes the drop callback registered alongside the message.
 */
import { pushSteer } from "../sessions/steer-channel";
import { getLogger } from "../logging";

const log = getLogger("in-turn-event");

/** Default cap on the italicized detail segment of a banner. */
const DEFAULT_DETAIL_CHARS = 60;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Build an emoji-lead blockquote banner for an in-turn event, e.g.
 * `> ↩️ Exec notification: *npm test* `n-12``.
 */
export function buildInTurnEventBanner(input: {
  readonly emoji: string;
  /** Short event title, e.g. "Exec notification". */
  readonly title: string;
  /** Optional italicized detail (e.g. the command preview); truncated. */
  readonly detail?: string;
  /** Optional monospace id (handle id, session id, …). */
  readonly id?: string;
  readonly maxDetailChars?: number;
}): string {
  const maxChars = input.maxDetailChars ?? DEFAULT_DETAIL_CHARS;
  const detail = input.detail ? `: *${truncate(input.detail, maxChars)}*` : "";
  const id = input.id ? ` \`${input.id}\`` : "";
  return `> ${input.emoji} ${input.title}${detail}${id}`;
}

export type InTurnEventOutcome = "in_turn" | "fallback";

/**
 * Deliver an event into the session's active turn via the steer channel.
 *
 * - Active turn: the message (banner + body) is queued for injection into the
 *   current tool loop; resolves `in_turn`.
 * - No active turn, or the turn ends before the message is drained: `fallback`
 *   runs instead (awaited for the no-turn case, fired from the channel's drop
 *   callback for the late case); resolves `fallback` only for the former.
 *
 * The fallback should be idempotent-safe to call at most once per delivery;
 * this function guarantees exactly one of the two paths delivers.
 */
export async function deliverInTurnEvent(input: {
  readonly sessionId: string;
  /** Full message content: banner line(s) followed by the event body. */
  readonly content: string;
  /** Delivered when in-turn delivery is impossible (no active turn / dropped). */
  readonly fallback: () => Promise<void>;
}): Promise<InTurnEventOutcome> {
  let fellBack = false;
  const runFallback = async (): Promise<void> => {
    if (fellBack) return;
    fellBack = true;
    try {
      await input.fallback();
    } catch (e) {
      log.warn("in-turn event fallback delivery failed", {
        sessionId: input.sessionId,
        err: String(e),
      });
    }
  };
  const injected = pushSteer(input.sessionId, input.content, {
    onDropped: () => {
      void runFallback();
    },
  });
  if (injected) return "in_turn";
  await runFallback();
  return "fallback";
}
