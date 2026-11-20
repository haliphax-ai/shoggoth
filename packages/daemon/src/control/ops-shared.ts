/**
 * Shared delivery helpers extracted from `integration-ops.ts`.
 *
 * This module owns the out-of-band (OOB) delivery stack used by subagent ops
 * (`subagent_spawn` in `subagent-ops.ts`) and by the messaging/timer/exec
 * notification delivery paths: parsing a model turn's structured response and
 * routing `to_operator` / `to_sender` fields to their destinations, plus the
 * terminated-target delivery guard backed by the session store bound at
 * daemon startup.
 */

import type { SystemContext } from "@shoggoth/shared";
import type { ModelInvocationParams } from "@shoggoth/models";
import { getLogger } from "../logging";
import type { SessionStore } from "../sessions/session-store";
import type { SessionManager } from "../sessions/session-manager";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import { terminatePersistentSubagentSession } from "../subagent/subagent-kill";
import {
  subagentRuntimeExtensionRef,
  type OobTurnBannerHandle,
} from "../subagent/subagent-extension-ref";
import type { OobTurnOutcome } from "../messaging/oob-turn-banner";
import { pushSteer } from "../sessions/steer-channel";
import { deliverInTurnEvent } from "../messaging/in-turn-event";
import { oneShotWakeFallback } from "../subagent/one-shot-wake-window";
import {
  formatOobFailureNotice,
  OOB_NO_SENDER_GUIDANCE,
  OOB_NUDGE_NO_SENDER,
  OOB_NUDGE_WITH_SENDER,
  OOB_SCHEMA_NO_SENDER,
  OOB_SCHEMA_WITH_SENDER,
  OOB_WITH_SENDER_GUIDANCE,
} from "../messaging/oob-response-schemas";

/**
 * Control-op context re-exported for the op modules (they import context and
 * error types from `integration-ops.ts`, which owns the canonical types).
 */
import { IntegrationOpError, type IntegrationOpsContext } from "./integration-ops";
import type { AuthenticatedPrincipal, WireRequest } from "@shoggoth/authn";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  crossAgentSessionSendAllowed,
  effectiveMaxSpawnDepth,
  maySpawnSubagentAtDepth,
  parseAgentSessionUrn,
} from "@shoggoth/shared";
import { resolveSessionTargetFromCliArg } from "./resolve-session-cli-target";
import type { SessionRow } from "../sessions/session-store";
import { computeSessionDepthFromStore } from "../sessions/session-store";

const ioLog = getLogger("integration-ops");

/**
 * Session store bound from daemon startup (see `bindIntegrationOpsSessionStore`)
 * for delivery guards that run outside an integration-ops request context.
 */
export let boundSessionStore: SessionStore | undefined;

/** Bind the session store used by out-of-context delivery guards (index.ts). */
export function bindIntegrationOpsSessionStore(sessions: SessionStore): void {
  boundSessionStore = sessions;
}

/** Structured failure code delivered to the spawning session when a one-shot
 * subagent outlives its wall-clock TTL. The code travels on every delivery path
 * (steer injection, OOB structured payload, and the spawn op response) so the
 * parent can detect it uniformly. */
export const ONE_SHOT_TTL_EXPIRED_CODE = "ERR_SUBAGENT_TTL_EXPIRED";

/** Terminate a one-shot child that outlived its wall-clock TTL: abort the in-flight
 * turn, dispose runtime handles, and kill the session (idempotent with the normal
 * completion path's `finally` teardown). */
export function terminateOneShotAfterTtl(
  sessionManager: SessionManager,
  childId: string,
  autoApproveGate?: HitlAutoApproveGate,
): void {
  try {
    terminatePersistentSubagentSession(
      sessionManager,
      childId,
      "ttl_expired",
      autoApproveGate,
      "one_shot_ttl",
    );
  } catch (e) {
    ioLog.warn("subagent.one_shot.ttl_terminate_failed", { childId, error: String(e) });
  }
}

/**
 * Deliver `ERR_SUBAGENT_TTL_EXPIRED` to the spawning session: steer-injected when a
 * turn is active, otherwise an OOB structured payload (mirroring subagent result
 * delivery) so the parent always learns that the child was cut off and may decide
 * whether to respawn with a larger budget. Best-effort: failures are logged, never
 * rethrown — the child is already terminated and nothing else can be done here.
 */
export async function deliverOneShotTtlExpiredFailure(opts: {
  readonly ext: NonNullable<typeof subagentRuntimeExtensionRef.current>;
  readonly parentSessionId: string;
  readonly childId: string;
  readonly childAgentId: string;
  readonly subLog: ReturnType<typeof getLogger>;
}): Promise<void> {
  const { ext, parentSessionId, childId, childAgentId, subLog } = opts;
  const detail = `one-shot subagent \`${childId}\` (**${childAgentId}**) terminated at its wall-clock TTL`;
  const steerBody = `[${ONE_SHOT_TTL_EXPIRED_CODE}] ${detail}\n\nRespawn with a larger \`ttl_minutes\` if the task needs more time.`;
  if (pushSteer(parentSessionId, steerBody)) {
    subLog.info("subagent one_shot ttl failure delivered in-turn", {
      parentSessionId,
      childId,
    });
    return;
  }
  const systemContext: SystemContext = {
    kind: "subagent.ttlExpired",
    summary: "A one-shot subagent was terminated at its wall-clock TTL.",
    data: {
      code: ONE_SHOT_TTL_EXPIRED_CODE,
      child_session_id: childId,
      agent_id: childAgentId,
    },
    guidance: OOB_NO_SENDER_GUIDANCE,
  };
  try {
    const turn = await ext.runSessionModelTurn({
      sessionId: parentSessionId,
      userContent: `[${ONE_SHOT_TTL_EXPIRED_CODE}] ${detail}`,
      userMetadata: {
        subagent_ttl_expired: true,
        error: ONE_SHOT_TTL_EXPIRED_CODE,
        child_session_id: childId,
        agent_id: childAgentId,
      },
      systemContext,
      delivery: { kind: "internal" },
      modelInvocationOverride: {
        responseSchema: { schema: OOB_SCHEMA_NO_SENDER },
        structuredOutputMode: "best-effort",
      },
    });
    if (turn?.aborted || turn?.latestAssistantText) {
      await deliverOobStructuredResponse({
        structuredResponse: turn.latestAssistantText,
        aborted: turn.aborted,
        respondTo: parentSessionId,
        childSessionId: childId,
        ext,
        subLog,
        hasSender: false,
        systemContext,
      });
    }
  } catch (e) {
    subLog.warn("failed to deliver one-shot subagent TTL failure", {
      parentSessionId,
      childId,
      error: String(e),
    });
  }
}

/**
 * Parse a structured OOB response and deliver fields to destinations.
 */
export async function deliverOobStructuredResponse(opts: {
  structuredResponse: string;
  aborted?: boolean;
  respondTo: string;
  childSessionId?: string;
  ext: NonNullable<typeof subagentRuntimeExtensionRef.current>;
  subLog: ReturnType<typeof getLogger>;
  maxChars?: number;
  hasSender: boolean;
  /**
   * The OOB system context of the turn being repaired. Replay it on the nudge
   * turn so the nudge reads as a *continuation* of the failed OOB turn rather
   * than an unrelated prompt.
   */
  systemContext?: SystemContext;
  /**
   * Live OOB banner handle (issue #363). When present, the terminal banner and
   * any `to_operator` content are folded into the banner message instead of
   * being posted separately, and the banner is finalized (or aborted) here.
   */
  banner?: {
    readonly handle: OobTurnBannerHandle;
    readonly terminal: (outcome: OobTurnOutcome) => string;
    /** Terminal status-bar line (✅/🛑/❌) rendered by the OOB turn's tracker;
     *  forwarded to `finish` so the banner's final edit carries the bar like
     *  every other turn surface. Omitted when the turn had no tracker. */
    readonly statusBar?: string;
  };
}): Promise<void> {
  const {
    structuredResponse,
    respondTo,
    childSessionId,
    ext,
    subLog,
    maxChars = 8000,
    hasSender,
    systemContext,
    banner,
  } = opts;

  /** Finalize the banner (issue #363) with a failed terminal + notice body.
   *  Returns true when a banner was finalized (caller should skip the plain
   *  postToOperator fallback). */
  const finishBannerFailed = async (notice: string): Promise<boolean> => {
    if (!banner) return false;
    try {
      await ext.oobTurnBanner?.finish({
        handle: banner.handle,
        terminal: banner.terminal("failed"),
        content: notice,
        ...(banner.statusBar ? { statusBar: banner.statusBar } : {}),
      });
    } catch (err) {
      subLog.warn("failed to finalize oob banner on failure", { respondTo, error: String(err) });
    }
    return true;
  };

  const announceAbort = async (): Promise<void> => {
    subLog.info("out-of-band turn aborted", { respondTo });
    // Banner path (issue #363): finalize the banner with the aborted terminal
    // instead of posting a separate abort notice.
    if (banner) {
      try {
        await ext.oobTurnBanner?.finish({
          handle: banner.handle,
          terminal: banner.terminal("aborted"),
          ...(banner.statusBar ? { statusBar: banner.statusBar } : {}),
        });
      } catch (err) {
        subLog.warn("failed to finalize oob banner on abort", { respondTo, error: String(err) });
      }
      return;
    }
    try {
      if (!ext.resolveOutboundChannelIdForSession?.(respondTo)) return;
      await ext.postToOperator?.({
        sessionId: respondTo,
        userContent: "🛑 An out-of-band turn was aborted.",
      });
    } catch (err) {
      subLog.warn("failed to announce out-of-band abort", { respondTo, error: String(err) });
    }
  };
  if (opts.aborted) {
    await announceAbort();
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(structuredResponse);
  } catch {
    subLog.warn("oob structured response parse failed, sending nudge", {
      structuredResponse: structuredResponse.slice(0, 200),
    });

    // Nudge: give the model one chance to correct its response format
    const nudgeSchema = hasSender ? OOB_SCHEMA_WITH_SENDER : OOB_SCHEMA_NO_SENDER;
    const nudgeGuidance = hasSender ? OOB_NUDGE_WITH_SENDER : OOB_NUDGE_NO_SENDER;

    try {
      /*
       * The nudge turn is a continuation of the failed OOB turn: it replays the
       * same OOB system context, runs on the same session with the same tool
       * set, and — via `responseSchema` — is presented with the synthetic
       * `__structured_output__` tool so the model can actually recover.
       */
      const nudgeResult = await ext.runSessionModelTurn({
        sessionId: respondTo,
        userContent: nudgeGuidance,
        delivery: { kind: "internal" },
        ...(systemContext ? { systemContext } : {}),
        modelInvocationOverride: {
          responseSchema: { schema: nudgeSchema },
          structuredOutputMode: "best-effort",
        },
      });

      if (nudgeResult?.aborted) {
        await announceAbort();
        return;
      }

      if (nudgeResult?.latestAssistantText) {
        try {
          parsed = JSON.parse(nudgeResult.latestAssistantText);
        } catch {
          // Nudge also produced invalid output — surface error to operator
          subLog.error("oob structured response parse failed after nudge", {
            respondTo,
            structuredResponse: nudgeResult.latestAssistantText.slice(0, 200),
          });
          const notice = formatOobFailureNotice(nudgeResult.latestAssistantText, maxChars);
          if (!(await finishBannerFailed(notice))) {
            await ext.postToOperator?.({ sessionId: respondTo, userContent: notice });
          }
          return;
        }
      } else {
        // Nudge produced no response
        subLog.error("oob nudge produced no response", { respondTo });
        const notice = formatOobFailureNotice(structuredResponse, maxChars);
        if (!(await finishBannerFailed(notice))) {
          await ext.postToOperator?.({ sessionId: respondTo, userContent: notice });
        }
        return;
      }
    } catch (nudgeErr) {
      // Nudge turn itself failed
      subLog.error("oob nudge turn failed", { respondTo, error: String(nudgeErr) });
      const notice = formatOobFailureNotice(structuredResponse, maxChars);
      if (!(await finishBannerFailed(notice))) {
        await ext.postToOperator?.({ sessionId: respondTo, userContent: notice });
      }
      return;
    }
  }

  // Deliver to operator
  const toOperator = parsed.to_operator;
  const toOperatorText =
    typeof toOperator === "string" && toOperator.length > 0
      ? toOperator.length > maxChars
        ? toOperator.slice(0, maxChars)
        : toOperator
      : undefined;
  if (banner) {
    // Banner path (issue #363): fold the terminal banner and any to_operator
    // content into the banner message, then finalize it.
    try {
      await ext.oobTurnBanner?.finish({
        handle: banner.handle,
        terminal: banner.terminal("finished"),
        ...(toOperatorText ? { content: toOperatorText } : {}),
        ...(banner.statusBar ? { statusBar: banner.statusBar } : {}),
      });
    } catch (err) {
      subLog.warn("failed to finalize oob banner", { respondTo, error: String(err) });
    }
  } else if (toOperatorText) {
    await ext.postToOperator?.({ sessionId: respondTo, userContent: toOperatorText });
  }

  // Deliver to sender (subagent results only). Delivery is guaranteed: a steer
  // entry dropped undrained (parent turn ended first) is re-delivered via the
  // same OOB turn the no-active-loop path uses.
  if (hasSender) {
    const toSender = parsed.to_sender;
    if (typeof toSender === "string" && toSender.length > 0) {
      const truncated = toSender.length > maxChars ? toSender.slice(0, maxChars) : toSender;
      await deliverInTurnEvent({
        sessionId: respondTo,
        content: truncated,
        /*
         * Wrapped fallback: the wake marker covers the OOB turn so a held
         * one-shot parent cannot release mid-delivery, and a terminated
         * parent is never dispatched (the stale to_sender is logged, not
         * laundered onto a dead row).
         */
        fallback: () =>
          oneShotWakeFallback(respondTo, async () => {
            if (!(await assertDeliveryTargetNotTerminated(respondTo, subLog))) return;
            try {
              await ext.runSessionModelTurn({
                sessionId: respondTo,
                userContent: truncated,
                userMetadata: {
                  subagent_result: true,
                  child_session_id: childSessionId,
                },
                delivery: { kind: "internal" },
              });
            } catch (err) {
              subLog.warn("failed to deliver oob to_sender", {
                respondTo,
                childSessionId,
                error: String(err),
              });
            }
          }),
      });
    }
  }
}

/**
 * Options for delivering a finished subagent result to its parent session.
 */
export type SubagentResultOpts = {
  childSessionId: string;
  /** Subagent shorthand agent ID, used to label event messages and logs. */
  childAgentId?: string;
  respondTo: string;
  internalDelivery: boolean;
  mode: "one_shot" | "persistent";
  deliveryMode: "inline" | "queue" | "drop";
  maxChars?: number;
  assistantText: string;
  subLog: ReturnType<typeof getLogger>;
  /** Optional override merged into the parent turn's model invocation params (e.g. responseSchema for structured output). */
  modelInvocationOverride?: Partial<ModelInvocationParams>;
  /**
   * Spawning session to fall back to when `respondTo` cannot receive the turn
   * (missing or terminated at delivery time). Omit to drop on failure (logged).
   */
  fallbackRespondTo?: string;
  /** Set internally on fallback delivery: the original `respond_to` that was unavailable. */
  unavailableRespondTo?: string;
  /**
   * Invoked once the result has been delivered through one of the delivery
   * paths (inline steer, OOB turn, or re-route). Lets a caller record what
   * was delivered without restructuring its control flow (e.g. the one-shot
   * spawn path marks the text so the teardown's final-result delivery can
   * dedupe against it).
   */
  onDelivered?: () => void;
};

/**
 * Terminated-target guard for OOB delivery paths: resolves the target row via
 * the store bound at startup (falling back to the caller-supplied one) and
 * returns false — logging, never throwing — when the session is missing or
 * terminated. Delivery paths call this before dispatching a turn so a stale
 * payload is logged and dropped instead of being laundered onto another
 * session's transcript through a dead-row error path.
 */
export async function assertDeliveryTargetNotTerminated(
  sessionId: string,
  log: ReturnType<typeof getLogger>,
): Promise<boolean> {
  const row = boundSessionStore?.getById(sessionId.trim());
  if (row?.status === "terminated") {
    log.warn("oob delivery target terminated; dispatch skipped", {
      sessionId,
    });
    return false;
  }
  // No store bound (tests/embeds) or row missing: the platform's own
  // runSessionModelTurn guard rejects terminated rows by throwing, so the
  // delivery stays fail-open here.
  return true;
}

/**
 * Dispatch the subagent result as an out-of-band queue turn. This is both the
 * normal path for queue-mode delivery and the guaranteed-delivery fallback for
 * inline mode (steer entry dropped undrained / no active steer channel) and for
 * re-routed deliveries.
 */
export async function runSubagentResultOobTurn(input: {
  readonly opts: SubagentResultOpts;
  readonly ext: NonNullable<typeof subagentRuntimeExtensionRef.current>;
  /** Parent-facing content: completed tag + result text + OOB guidance. */
  readonly asyncContent: string;
  readonly systemContext: SystemContext;
  /** Resolved `maxChars` (the default is applied by callers); kept explicit so the truncation width is visible at the call site. */
  readonly maxChars: number;
}): Promise<void> {
  const { opts } = input;
  const {
    childSessionId,
    respondTo,
    internalDelivery,
    mode,
    subLog,
    modelInvocationOverride,
    fallbackRespondTo,
    unavailableRespondTo,
  } = opts;
  const { ext, asyncContent, systemContext, maxChars } = input;

  /*
   * Only the turn dispatch is guarded for fallback: a throw here means the target
   * session could not run a turn (missing/terminated), so the result has not been
   * delivered anywhere yet and can safely be re-routed.
   * The dispatch is wrapped in the one-shot wake marker: a held one-shot parent
   * must not release while this parent-delivery turn is in flight. A terminated
   * target is never dispatched — the guard skips the turn so the delivery falls
   * through to the re-route/drop handling below instead of throwing on a dead row.
   */
  let turnResult: Awaited<ReturnType<typeof ext.runSessionModelTurn>>;
  try {
    turnResult = await oneShotWakeFallback(respondTo, async () => {
      if (!(await assertDeliveryTargetNotTerminated(respondTo, subLog))) {
        return undefined as never;
      }
      return ext.runSessionModelTurn({
        sessionId: respondTo,
        userContent: asyncContent,
        userMetadata: {
          subagent_result: true,
          child_session_id: childSessionId,
          mode,
        },
        systemContext,
        delivery: { kind: "internal" },
        modelInvocationOverride: {
          // OOB structured output is the default for the parent delivery turn; a
          // caller-supplied override is shallow-merged on top so partial overrides
          // (e.g. temperature) keep the OOB response schema intact.
          responseSchema: { schema: OOB_SCHEMA_WITH_SENDER },
          structuredOutputMode: "best-effort",
          ...modelInvocationOverride,
        },
      });
    });
  } catch (err) {
    subLog.warn("failed to deliver subagent result to respond_to session", {
      childSessionId,
      respondTo,
      mode,
      error: String(err),
    });
    if (fallbackRespondTo && fallbackRespondTo !== respondTo && !unavailableRespondTo) {
      subLog.info("re-routing subagent result to spawning session", {
        childSessionId,
        respondTo,
        fallbackRespondTo,
        mode,
      });
      await deliverSubagentResult(ext, {
        ...opts,
        respondTo: fallbackRespondTo,
        fallbackRespondTo: undefined,
        unavailableRespondTo: respondTo,
      });
      return;
    }
    subLog.warn("subagent result dropped: no live delivery target", {
      childSessionId,
      respondTo,
      fallbackRespondTo,
      mode,
    });
    return;
  }

  try {
    if (turnResult?.aborted || turnResult?.latestAssistantText) {
      await deliverOobStructuredResponse({
        structuredResponse: turnResult.latestAssistantText,
        aborted: turnResult.aborted,
        respondTo,
        childSessionId,
        ext,
        subLog,
        maxChars,
        hasSender: true,
        systemContext,
      });
    }
    subLog.info("subagent result delivered to respond_to session", {
      childSessionId,
      respondTo,
      mode,
      internal: internalDelivery,
    });
  } catch (err) {
    subLog.warn("failed to finalize subagent result delivery", {
      childSessionId,
      respondTo,
      mode,
      error: String(err),
    });
  }
}

export async function deliverSubagentResult(
  ext: NonNullable<typeof subagentRuntimeExtensionRef.current>,
  opts: SubagentResultOpts,
): Promise<void> {
  const {
    childSessionId,
    respondTo,
    internalDelivery,
    mode,
    deliveryMode,
    assistantText,
    subLog,
    maxChars = 8000,
    unavailableRespondTo,
    childAgentId,
  } = opts;

  // drop mode: do nothing
  if (deliveryMode === "drop") {
    subLog.info("subagent result delivery skipped (drop mode)", {
      childSessionId,
      respondTo,
      mode,
    });
    return;
  }
  // Truncate to maxChars
  const truncatedText =
    assistantText.length > maxChars ? assistantText.slice(0, maxChars) : assistantText;
  const completedTag = unavailableRespondTo
    ? `[Subagent completed — respond_to ${unavailableRespondTo} unavailable]`
    : "[Subagent completed]";
  const childLabel = childAgentId
    ? `\`${childSessionId}\` (**${childAgentId}**)`
    : `\`${childSessionId}\``;
  const baseContent = `${completedTag} session_id: ${childLabel}\n\n${truncatedText}`;

  /*
   * Reminders appended to the delivery paths:
   * - baseReminder tells the parent its reply routes back to the subagent, not the operator.
   *   (inline steer path only)
   * - OOB_WITH_SENDER_GUIDANCE instructs the parent to respond with structured OOB
   *   output (to_operator / to_sender) on the async/queue path.
   */
  const baseReminder = "\n\n— Your reply text is delivered to the subagent, not to the operator.";
  const steerContent = baseContent + baseReminder;
  const asyncContent = baseContent + OOB_WITH_SENDER_GUIDANCE;

  // OOB system context for the delivery turn. It is replayed by the nudge turn
  // inside deliverOobStructuredResponse so that a format-failure nudge reads as
  // a continuation of this same OOB turn rather than an unrelated prompt.
  const oobSystemContext: SystemContext = {
    kind: "subagent.result",
    summary: `Result delivered from subagent ${childSessionId}.`,
    data: {
      child_session_id: childSessionId,
      mode,
    },
  };

  const runOobDelivery = async (): Promise<void> =>
    runSubagentResultOobTurn({
      opts,
      ext,
      asyncContent,
      systemContext: oobSystemContext,
      maxChars,
    });

  /*
   * inline mode: attempt steer injection first. Delivery is guaranteed: if the
   * turn ends (or is replaced) before the entry is drained, the drop callback
   * re-delivers via the OOB queue turn so the completion notice can never be
   * silently destroyed by the channel teardown.
   */
  if (deliveryMode === "inline") {
    const delivered = await deliverInTurnEvent({
      sessionId: respondTo,
      content: steerContent,
      fallback: async () => {
        subLog.info("subagent result re-delivered OOB after inline steer drop", {
          childSessionId,
          respondTo,
          mode,
        });
        return runOobDelivery();
      },
    });
    // Either the entry was injected into the active turn ("in_turn") or the
    // fallback already delivered it via the OOB queue turn ("fallback" covers
    // both no-active-turn and the dropped-undrained case) — never both.
    subLog.info(
      delivered === "in_turn"
        ? "subagent result injected inline via steer channel"
        : "subagent result delivered OOB (no active steer channel)",
      {
        childSessionId,
        respondTo,
        mode,
        internal: internalDelivery,
      },
    );
    opts.onDelivered?.();
    return;
  }

  await runOobDelivery();
  opts.onDelivered?.();
}

/**
 * Payload-parse helpers shared by the control-op modules. Extracted verbatim
 * from `integration-ops.ts`.
 */

export function payloadObject(req: WireRequest): Record<string, unknown> {
  const p = req.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload must be a JSON object");
  }
  return p as Record<string, unknown>;
}

export function optionalRecordObject(
  pl: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = pl[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      `payload.${key} must be a non-empty string`,
    );
  }
  return v;
}

export function optionalFinitePositiveInt(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be a finite number`);
  }
  const n = Math.trunc(v);
  if (n < 1) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be positive`);
  }
  return n;
}

export function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      `payload.${key} must be an array of strings`,
    );
  }
  return v as string[];
}

/**
 * Optional boolean payload flag (e.g. `wait`). Absent → `undefined` so the
 * caller applies its own default; a present value must be a boolean.
 */
export function optionalBooleanFlag(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be a boolean`);
  }
  return v;
}

/**
 * Resolve `payload.session_id` to a full agent session URN. Accepts either a valid session URN
 * or a bare agent id (substituted with that agent's bootstrap primary session URN).
 */
export function requireSessionId(
  pl: Record<string, unknown>,
  cfg: ShoggothConfig,
  sessions: SessionStore | undefined,
): string {
  return resolveTargetSessionIdOrThrow(requireString(pl, "session_id"), cfg, sessions);
}

function resolveTargetSessionIdOrThrow(
  raw: string,
  cfg: ShoggothConfig,
  sessions: SessionStore | undefined,
): string {
  try {
    return resolveSessionTargetFromCliArg(raw, cfg, sessions);
  } catch (e) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", e instanceof Error ? e.message : String(e));
  }
}

export function mapSessionListRow(row: SessionRow) {
  return {
    id: row.id,
    status: row.status,
    workspace_path: row.workspacePath,
    context_segment_id: row.contextSegmentId,
    parent_session_id: row.parentSessionId ?? null,
    subagent_mode: row.subagentMode ?? null,
    subagent_platform_thread_id: row.subagentPlatformThreadId ?? null,
    subagent_expires_at_ms: row.subagentExpiresAtMs ?? null,
    light_context: row.lightContext,
    created_at: row.createdAt || null,
    updated_at: row.updatedAt || null,
  };
}

/** Resolve target session id from `session_id` or bootstrap main session for `agent_id`. */
export function resolveSessionSendTargetSessionId(
  pl: Record<string, unknown>,
  cfg: ShoggothConfig,
  sessions: SessionStore | undefined,
): string {
  const sidRaw = pl.session_id;
  const aidRaw = pl.agent_id;
  const hasSid = typeof sidRaw === "string" && sidRaw.trim();
  const hasAid = typeof aidRaw === "string" && aidRaw.trim();
  if (hasSid && hasAid) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload must not set both session_id and agent_id",
    );
  }
  if (hasSid) return resolveTargetSessionIdOrThrow((sidRaw as string).trim(), cfg, sessions);
  if (hasAid) {
    return resolveSessionTargetFromCliArg((aidRaw as string).trim(), cfg, sessions);
  }
  throw new IntegrationOpError(
    "ERR_INVALID_PAYLOAD",
    "payload.session_id or payload.agent_id is required",
  );
}

/**
 * Agents may `session_send` to their own agent's sessions always; cross-agent sends require
 * Top-level `agentToAgent.allow` plus optional per-agent `agents.list.<id>.agentToAgent.allow`.
 */
export function assertAgentMayTargetSessionForSendOrList(
  principal: AuthenticatedPrincipal,
  targetSessionId: string,
  config: ShoggothConfig,
): void {
  if (principal.kind !== "agent") return;
  const callerAgentId = parseAgentSessionUrn(principal.sessionId)?.agentId;
  const targetAgentId = parseAgentSessionUrn(targetSessionId)?.agentId;
  if (!callerAgentId || !targetAgentId) {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "agent session_send requires valid agent session URNs for caller and target",
    );
  }
  if (!crossAgentSessionSendAllowed(config, callerAgentId, targetAgentId)) {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "cross-agent session_send denied (configure agentToAgent.allow and/or agents.list.<id>.agentToAgent.allow)",
    );
  }
}

export function requireSubagentRuntime(ctx: IntegrationOpsContext): {
  sessions: NonNullable<IntegrationOpsContext["sessions"]>;
  sessionManager: NonNullable<IntegrationOpsContext["sessionManager"]>;
} {
  if (!ctx.stateDb || !ctx.sessions || !ctx.sessionManager) {
    throw new IntegrationOpError(
      "ERR_STATE_DB_REQUIRED",
      "subagent ops require SQLite state and session manager",
    );
  }
  return { sessions: ctx.sessions, sessionManager: ctx.sessionManager };
}

export function assertAgentMayUseSubagentSessionOps(
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): void {
  if (principal.kind !== "agent") return;
  const { sessions } = requireSubagentRuntime(ctx);
  const row = sessions.getById(principal.sessionId);
  if (!row) {
    throw new IntegrationOpError("ERR_PARENT_SESSION_INVALID", "session is missing or terminated");
  }
  const depth = computeSessionDepthFromStore(sessions, principal.sessionId);
  const maxDepth = effectiveMaxSpawnDepth(
    ctx.config,
    parseAgentSessionUrn(principal.sessionId)?.agentId,
  );
  if (!maySpawnSubagentAtDepth(depth, maxDepth)) {
    throw new IntegrationOpError(
      "ERR_SUBAGENT_NESTING_FORBIDDEN",
      `subagent operations denied: nesting depth limit reached (maxSpawnDepth: ${maxDepth})`,
    );
  }
}
