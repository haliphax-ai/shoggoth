/**
 * Runaway agent circuit breaker.
 *
 * Deterministic detection of a model stuck in a tool-call loop: it keeps
 * issuing the same call (same tool name, same — truncated — arguments) until
 * its TTL burns the token budget. The detector tracks a rolling window of the
 * most recent tool-call signatures and trips when any one signature's count
 * within the window exceeds the configured maximum.
 *
 * Two-stage response, mirroring a physical circuit breaker:
 *
 * 1. First trip — `steer`: the model receives an injected steering message
 *    telling it to change approach; the window resets so it gets a fresh
 *    chance to recover.
 * 2. Second trip — `cancel`: the turn is terminated cleanly (same
 *    `break`-style as the other in-loop circuit breakers) and a warning is
 *    raised — folded into the turn's transcript output so it rides the normal
 *    delivery path to the parent session (subagents) or message surface
 *    (top-level agents).
 */

/** Rolling window of recent tool calls inspected per trip. */
export const RUNAWAY_WINDOW_SIZE = 15;

/**
 * Maximum occurrences of one signature (tool name + truncated args) within
 * the window before the breaker trips. The issue's heuristic: "track the
 * last 15 tool calls with truncated arguments and break when the total
 * duplicate count exceeds 2".
 */
export const RUNAWAY_MAX_DUPLICATES = 2;

/**
 * Argument characters folded into a call's signature. Calls that differ only
 * past this point (timestamps deep in a JSON blob, etc.) count as duplicates.
 */
export const RUNAWAY_SIGNATURE_ARGS_CHARS = 200;

export interface RunawayTrigger {
  readonly toolName: string;
  readonly count: number;
  /** Tool name plus truncated args — what the detector matched on. */
  readonly signature: string;
}

export type RunawayVerdict =
  | { readonly verdict: "ok" }
  | { readonly verdict: "steer" | "cancel"; readonly trigger: RunawayTrigger };

export interface RunawayBreakerOptions {
  readonly windowSize?: number;
  readonly maxDuplicates?: number;
  readonly signatureArgsChars?: number;
}

export class RunawayBreaker {
  private readonly windowSize: number;
  private readonly maxDuplicates: number;
  private readonly signatureArgsChars: number;
  /** FIFO of recent signatures; newest last. */
  private readonly window: string[] = [];
  private steeredOnce = false;

  constructor(options: RunawayBreakerOptions = {}) {
    this.windowSize = options.windowSize ?? RUNAWAY_WINDOW_SIZE;
    this.maxDuplicates = options.maxDuplicates ?? RUNAWAY_MAX_DUPLICATES;
    this.signatureArgsChars = options.signatureArgsChars ?? RUNAWAY_SIGNATURE_ARGS_CHARS;
  }

  /** True once a steer has been issued this turn (a next trip cancels). */
  get steered(): boolean {
    return this.steeredOnce;
  }

  /**
   * Record one tool call and evaluate the window.
   *
   * Returns `steer` the first time a signature's window-count exceeds the
   * maximum, `cancel` on any later trip, `ok` otherwise. Both trip verdicts
   * reset the window so the model is judged on fresh behavior afterwards.
   */
  record(toolName: string, argsJson: string): RunawayVerdict {
    const signature = `${toolName}|${argsJson.slice(0, this.signatureArgsChars)}`;
    this.window.push(signature);
    while (this.window.length > this.windowSize) this.window.shift();

    let count = 0;
    for (const s of this.window) if (s === signature) count++;

    if (count <= this.maxDuplicates) return { verdict: "ok" };

    const trigger: RunawayTrigger = { toolName, count, signature };
    const verdict = this.steeredOnce ? "cancel" : "steer";
    this.steeredOnce = true;
    this.window.length = 0;
    return { verdict, trigger };
  }
}

/** Cap on the tool/args preview embedded in steer copy. */
const PREVIEW_MAX_CHARS = 80;

function preview(trigger: RunawayTrigger): string {
  const args = trigger.signature.includes("|")
    ? trigger.signature.slice(trigger.signature.indexOf("|") + 1)
    : trigger.signature;
  const span = args ? `${trigger.toolName}: ${args}` : trigger.toolName;
  return span.length > PREVIEW_MAX_CHARS ? `${span.slice(0, PREVIEW_MAX_CHARS)}…` : span;
}

/** Model-facing steering message injected into the loop on the first trip. */
export function buildRunawaySteerMessage(trigger: RunawayTrigger): string {
  return (
    `Circuit breaker: you have issued the identical tool call ${trigger.count} times ` +
    `in quick succession (\`${preview(trigger)}\`). This pattern looks like a runaway ` +
    `loop. STOP repeating the same call — either change your approach (different ` +
    `arguments or a different tool) or conclude your turn with a prose response ` +
    `explaining what you are stuck on. Repeating the call again will cancel this turn.`
  );
}

/** In-turn operator banner for a steer (folded into the active turn output). */
export function buildRunawaySteerBanner(trigger: RunawayTrigger): string {
  return `> ⚠️ Runaway breaker **steered** \`${preview(trigger)}\` (×${trigger.count})`;
}

/**
 * Operator-facing cancel warning. Deliberately plain text: it is appended to
 * the turn's transcript as assistant prose, so it rides the same delivery
 * path as any other reply — parent session for subagents, message surface
 * for top-level agents.
 */
export function buildRunawayCancelNotice(trigger: RunawayTrigger): string {
  return (
    `⚠️ Runaway circuit breaker: turn canceled — the identical tool call ` +
    `\`${preview(trigger)}\` was issued ${trigger.count} times despite a steering ` +
    `warning. No further tool calls were executed.`
  );
}
