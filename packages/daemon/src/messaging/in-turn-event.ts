/**
 * In-turn event banners and delivery: async completions that land while the
 * agent's turn is still running are delivered into the *current* turn through
 * the session's steer channel instead of spinning up an out-of-band turn.
 * Banners use the emoji-lead blockquote pattern shared with `oob-turn-banner.ts`.
 * See docs/daemon.md (Turn Output Presentation) for the full delivery model.
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

/**
 * Build the operator-facing banner for an operator `/steer` injection: a
 * `> 🫵 **Steered:** <prompt>` blockquote that anchors the directive to the
 * spot where it was sent to the model. Mirrors the in-turn event banner
 * aesthetic (emoji-lead blockquote) so steering directives read as part of
 * the turn's own output rather than as a separate status message.
 */
export function buildSteerBanner(prompt: string): string {
  return `> 🫵 **Steered:** ${prompt}`;
}

/**
 * Build the turn-surface rendering for a drained steer-channel message.
 *
 * In-turn event deliveries (exec notifications, session-send replies, …) ride
 * the same steer channel as operator prompts but already lead with their own
 * blockquote banner; re-wrapping them under a 🫵 **Steered:** lead would stack
 * two banners on one message. Such content surfaces verbatim; bare prompts
 * still get the standard steer banner.
 */
export function buildInjectedSteerSurface(content: string): string {
  if (content.startsWith("> ")) return content;
  return buildSteerBanner(content);
}

export type InTurnEventOutcome = "in_turn" | "fallback";

/**
 * Deliver an event into the session's active turn via the steer channel.
 * Active turn: the message (banner + body) is queued for injection into the
 * current tool loop (resolves `in_turn`). No active turn — or the turn ends
 * before the message is drained — and the caller's `fallback` path delivers
 * instead (resolves `fallback` only for the no-turn case). Guarantees exactly
 * one of the two paths delivers; see docs/daemon.md (Turn Output Presentation).
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
