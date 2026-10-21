/**
 * Runaway agent circuit breaker.
 *
 * Deterministic detection of runaway model behavior that burns the token
 * budget until the TTL expires. Two heuristics, one shared two-stage state:
 *
 * - **Duplicate tool calls**: the model keeps issuing the same call (same
 *   tool name, same — truncated — arguments). A rolling window of the most
 *   recent tool-call signatures trips when any one signature's count within
 *   the window exceeds the configured maximum.
 * - **Excessive prose**: the model generates long prose without the tool
 *   activity needed to make progress (a runaway monologue). Accumulated
 *   assistant prose is charged against a per-turn character budget.
 *
 * Two-stage response, mirroring a physical circuit breaker:
 *
 * 1. First trip — `steer`: the model receives an injected steering message
 *    telling it to change approach; the window resets so it gets a fresh
 *    chance to recover.
 * 2. Second trip — `cancel`: the turn is terminated cleanly (same
 *    `break`-style as the other in-loop circuit breakers) and an operator
 *    notice is posted once through the active turn surface's in-turn banner
 *    path (silently skipped when no live surface exists).
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

/**
 * Prose character budget for a single turn before the breaker trips: prose
 * generation without tool calls is the other runaway shape called out in the
 * issue — a model that talks and talks without ever acting burns the token
 * budget just as hard as a duplicate tool-call loop. Accumulated assistant
 * prose is charged against this budget as hops complete.
 */
export const RUNAWAY_PROSE_CHAR_LIMIT = 20_000;

/** Duplicate-tool-call trigger: which call repeated, and how often. */
export interface RunawayDuplicateTrigger {
  readonly kind: "duplicate_tool_call";
  readonly toolName: string;
  readonly count: number;
  /** Tool name plus truncated args — what the detector matched on. */
  readonly signature: string;
}

/** Excessive-prose trigger: how many prose characters the turn has burned. */
export interface RunawayProseTrigger {
  readonly kind: "excessive_prose";
  readonly chars: number;
}

export type RunawayTrigger = RunawayDuplicateTrigger | RunawayProseTrigger;

export type RunawayVerdict =
  | { readonly verdict: "ok" }
  | { readonly verdict: "steer" | "cancel"; readonly trigger: RunawayTrigger };

export interface RunawayBreakerOptions {
  readonly windowSize?: number;
  readonly maxDuplicates?: number;
  readonly signatureArgsChars?: number;
  readonly proseCharLimit?: number;
}

export class RunawayBreaker {
  private readonly windowSize: number;
  private readonly maxDuplicates: number;
  private readonly signatureArgsChars: number;
  private readonly proseCharLimit: number;
  /** FIFO of recent signatures; newest last. */
  private readonly window: string[] = [];
  /** Prose characters accumulated since the last trip/reset. */
  private proseChars = 0;
  private steeredOnce = false;

  constructor(options: RunawayBreakerOptions = {}) {
    this.windowSize = options.windowSize ?? RUNAWAY_WINDOW_SIZE;
    this.maxDuplicates = options.maxDuplicates ?? RUNAWAY_MAX_DUPLICATES;
    this.signatureArgsChars = options.signatureArgsChars ?? RUNAWAY_SIGNATURE_ARGS_CHARS;
    this.proseCharLimit = options.proseCharLimit ?? RUNAWAY_PROSE_CHAR_LIMIT;
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

    const trigger: RunawayTrigger = { kind: "duplicate_tool_call", toolName, count, signature };
    return this.trip(trigger);
  }

  /**
   * Charge prose characters generated this turn (e.g. the assistant content
   * of a hop that issued no tool calls) against the prose budget. Trips when
   * the accumulated total crosses the limit, then resets the budget — same
   * steer-once / cancel-on-second contract as {@link record}, with the
   * shared per-turn `steered` state.
   */
  recordProse(charCount: number): RunawayVerdict {
    this.proseChars += charCount;
    if (this.proseChars <= this.proseCharLimit) return { verdict: "ok" };
    const trigger: RunawayTrigger = { kind: "excessive_prose", chars: this.proseChars };
    return this.trip(trigger);
  }

  /** Shared two-stage trip bookkeeping: steer once, cancel after. */
  private trip(trigger: RunawayTrigger): RunawayVerdict {
    const verdict = this.steeredOnce ? "cancel" : "steer";
    this.steeredOnce = true;
    this.window.length = 0;
    this.proseChars = 0;
    return { verdict, trigger };
  }
}

/** Cap on the tool/args preview embedded in steer copy. */
const PREVIEW_MAX_CHARS = 80;

function preview(trigger: RunawayTrigger): string {
  const span =
    trigger.kind === "duplicate_tool_call"
      ? (() => {
          const args = trigger.signature.includes("|")
            ? trigger.signature.slice(trigger.signature.indexOf("|") + 1)
            : trigger.signature;
          return args ? `${trigger.toolName}: ${args}` : trigger.toolName;
        })()
      : `${trigger.chars} chars of prose`;
  return span.length > PREVIEW_MAX_CHARS ? `${span.slice(0, PREVIEW_MAX_CHARS)}…` : span;
}

/** Model-facing steering message injected into the loop on the first trip. */
export function buildRunawaySteerMessage(trigger: RunawayTrigger): string {
  if (trigger.kind === "excessive_prose") {
    return (
      `Circuit breaker: this turn has generated ${trigger.chars} characters of prose ` +
      `without the tool activity needed to make progress. This pattern looks like a ` +
      `runaway monologue. STOP writing long prose — either call the tools you need to ` +
      `actually accomplish the task, or conclude your turn with a SHORT summary of ` +
      `what you have done and what is blocking you. Continuing to generate prose will ` +
      `cancel this turn.`
    );
  }
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
  const suffix = trigger.kind === "duplicate_tool_call" ? ` (×${trigger.count})` : "";
  return `> ⚠️ Runaway breaker **steered** \`${preview(trigger)}\`${suffix}`;
}

/**
 * Operator-facing cancel notice, delivered exactly once as a standard
 * in-turn surface banner (same path as the steer banner); silently skipped
 * when no live turn surface exists.
 */
export function buildRunawayCancelNotice(trigger: RunawayTrigger): string {
  const tail = `the final call was blocked and no further tool calls were executed.`;
  if (trigger.kind === "excessive_prose") {
    return (
      `> ⚠️ Runaway breaker: turn canceled — the turn generated ${trigger.chars} ` +
      `characters of prose without sufficient tool activity despite a steering warning; ` +
      tail
    );
  }
  return (
    `> ⚠️ Runaway breaker: turn canceled — the identical tool call ` +
    `\`${preview(trigger)}\` was issued ${trigger.count} times despite a steering warning; ` +
    tail
  );
}
