import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type Database from "better-sqlite3";
import type { ShoggothConfig, SystemContext } from "@shoggoth/shared";
import { getLogger } from "../logging";

const ioLog = getLogger("integration-ops");

/**
 * The session store bound for delivery guards that run outside an
 * integration-ops request context is owned by `ops-shared.ts` (the shared OOB
 * delivery stack); this module reads the same live binding and re-exports the
 * binder for `index.ts`.
 */
import { boundSessionStore } from "./ops-shared";

export { bindIntegrationOpsSessionStore } from "./ops-shared";
import type { AppendAuditRowInput } from "../audit/append-audit";
import type { AcpxProcessSupervisor } from "../acpx/acpx-process-supervisor";
import type { AcpxBindingStore } from "../acpx/sqlite-acpx-bindings";
import type { SessionManager } from "../sessions/session-manager";
import type { SessionStore } from "../sessions/session-store";
import type { HitlConfigRef } from "../config-hot-reload";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import type { CruiseControlStore } from "../hitl/cruise-control";
import type { ModelInvocationParams } from "@shoggoth/models";
import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import type { OobTurnBannerHandle } from "../subagent/subagent-extension-ref";
import type { OobTurnOutcome } from "../messaging/oob-turn-banner";
import { oneShotWakeFallback } from "../subagent/one-shot-notify-drain";
import { deliverInTurnEvent } from "../messaging/in-turn-event";
import {
  formatOobFailureNotice,
  OOB_NUDGE_NO_SENDER,
  OOB_NUDGE_WITH_SENDER,
  OOB_SCHEMA_NO_SENDER,
  OOB_SCHEMA_WITH_SENDER,
  OOB_WITH_SENDER_GUIDANCE,
} from "../messaging/oob-response-schemas";
import {
  handleVaultSet,
  handleVaultGet,
  handleVaultDelete,
  handleVaultList,
  handleVaultImport,
  handleVaultRotateKey,
} from "./vault-ops";
import {
  handleServiceList,
  handleServiceRequests,
  handleServiceRequest,
  handleServiceApprove,
  handleServiceRevoke,
  handleServiceRotateKey,
} from "./service-ops";
import {
  handleAcpxBindGet,
  handleAcpxBindSet,
  handleAcpxBindDelete,
  handleAcpxBindList,
  handleAcpxAgentStart,
  handleAcpxAgentStop,
  handleAcpxAgentList,
} from "./acpx-ops";
import {
  handleSessionContextNew,
  handleSessionContextReset,
  handleSessionCompact,
} from "./session-context-ops";
import { handleMcpHttpCancelRequest } from "./mcp-ops";
import {
  handleHitlPendingList,
  handleHitlPendingGet,
  handleHitlPendingApprove,
  handleHitlPendingDeny,
  handleHitlClear,
  handleHitlCruiseControl,
} from "./hitl-ops";
import { handlePrompt, handlePromptList } from "./prompt-ops-handler";
import { handleConfigShow, handleConfigRequest } from "./config-ops";
import { handleProcmanList, handleProcmanRestart, handleProcmanStop } from "./procman-ops";
import { handleElevationGrant, handleElevationRevoke, handleElevationList } from "./elevation-ops";
import { handleYoloMode } from "./yolo-ops";
import { handleMediaGenerate, handleMediaGeneratePoll } from "./media-ops";
import { handleDecisionEvaluate, handleRerankDocuments } from "./decision-ops";
import { handleSubagentSpawn, handleSubagentWait, handleSubagentResult } from "./subagent-ops";
import {
  handleSessionList,
  handleSessionContextStatus,
  handleSessionInspect,
  handleSessionSend,
  handleSessionSteer,
  handleSessionAbort,
  handleSessionKill,
  handleSessionModel,
  handleSessionQueueManage,
} from "./session-ops";

export class IntegrationOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationOpError";
  }
}

export type IntegrationAuditRecorder = (
  row: Pick<AppendAuditRowInput, "action" | "resource" | "outcome" | "argsRedactedJson">,
) => void;

export type IntegrationOpsContext = {
  readonly config: ShoggothConfig;
  /** SQLite handle for transcript deletes and other stateful integration ops. */
  readonly stateDb: Database.Database | undefined;
  readonly acpxStore: AcpxBindingStore | undefined;
  readonly sessions: SessionStore | undefined;
  readonly sessionManager: SessionManager | undefined;
  readonly acpxSupervisor: AcpxProcessSupervisor | undefined;
  readonly recordIntegrationAudit: IntegrationAuditRecorder;
  /** When unset, HITL control ops return ERR_HITL_UNAVAILABLE. */
  readonly hitlPending?: PendingActionsStore;
  /**
   * Cruise control (HITL auto-pilot) store. When unset, `hitl_cruise_control`
   * returns ERR_CRUISE_UNAVAILABLE.
   */
  readonly cruiseControl?: CruiseControlStore;
  /**
   * When set with {@link hitlPending}, `hitl_clear` can wipe agent/session auto-approve (disk + memory).
   * Omitted in minimal setups (e.g. tests with only the pending store).
   */
  readonly hitlClear?: {
    readonly configDirectory: string;
    readonly dynamicConfigDirectory?: string;
    readonly configRef: { current: ShoggothConfig };
    readonly hitlRef: HitlConfigRef;
    readonly autoApproveGate: HitlAutoApproveGate;
  };
  /**
   * MCP streamable HTTP cancel routing (default: process registry filled by the active platform).
   * Override in tests.
   */
  /** The vault service for credential management. */
  readonly vault?: import("../vault/vault-service").VaultService;
  /** The service approval store for managed services. */
  readonly serviceApprovalStore?: import("../service-approval-store").ServiceApprovalStore;
  /** The service registry for managed services. */
  readonly serviceRegistry?: import("../service-registry").ServiceRegistry;
  /** The service tool registry for managed services. */
  /** The service tool registry for managed services. */
  readonly serviceToolRegistry?: import("../service-tool-registry").ServiceToolRegistry;
  /** The service key store for age key management. */
  readonly serviceKeyStore?: import("../service-key-store").ServiceKeyStore;
  /**
   * Media generation service factory. Defaults to {@link MediaGenerationService.fromConfig}.
   * Override in tests to inject a fake instead of mocking the module.
   */
  readonly createMediaGenerationService?: (
    config: import("@shoggoth/shared").ShoggothMediaGenerationConfig,
  ) => import("../media/media-generation-service").MediaGenerationService;
  /**
   * Rerank service factory. Defaults to {@link RerankService.fromConfig}.
   * Override in tests to inject a fake instead of mocking the module.
   */
  readonly createRerankService?: (
    config: import("@shoggoth/shared").ShoggothRerankConfig,
  ) => import("../rerank/rerank-service").RerankService;
  readonly cancelMcpHttpRequest?: (input: {
    readonly sessionId: string;
    readonly sourceId: string;
    readonly requestId: number;
  }) => boolean;
};

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
      // The nudge turn is a continuation of the failed OOB turn: it replays the
      // same OOB system context, runs on the same session with the same tool
      // set, and — via `responseSchema` — is presented with the synthetic
      // `__structured_output__` tool so the model can actually recover.
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
        // Wrapped fallback: the wake marker covers the OOB turn so a held
        // one-shot parent cannot release mid-delivery, and a terminated
        // parent is never dispatched (the stale to_sender is logged, not
        // laundered onto a dead row).
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
type SubagentResultOpts = {
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
};

/**
 * Terminated-target guard for OOB delivery paths: resolves the target row via
 * the store bound at startup (falling back to the caller-supplied one) and
 * returns false — logging, never throwing — when the session is missing or
 * terminated. Delivery paths call this before dispatching a turn so a stale
 * payload is logged and dropped instead of being laundered onto another
 * session's transcript through a dead-row error path.
 */
async function assertDeliveryTargetNotTerminated(
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
async function runSubagentResultOobTurn(input: {
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

  // Only the turn dispatch is guarded for fallback: a throw here means the target
  // session could not run a turn (missing/terminated), so the result has not been
  // delivered anywhere yet and can safely be re-routed.
  // The dispatch is wrapped in the one-shot wake marker: a held one-shot parent
  // must not release while this parent-delivery turn is in flight. A terminated
  // target is never dispatched — the guard skips the turn so the delivery falls
  // through to the re-route/drop handling below instead of throwing on a dead row.
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

  // Reminders appended to the delivery paths:
  // - baseReminder tells the parent its reply routes back to the subagent, not the operator.
  //   (inline steer path only)
  // - OOB_WITH_SENDER_GUIDANCE instructs the parent to respond with structured OOB
  //   output (to_operator / to_sender) on the async/queue path.
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

  // inline mode: attempt steer injection first. Delivery is guaranteed: if the
  // turn ends (or is replaced) before the entry is drained, the drop callback
  // re-delivers via the OOB queue turn so the completion notice can never be
  // silently destroyed by the channel teardown.
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
    return;
  }

  await runOobDelivery();
}

/**
 * Integration control-op router. `req.op` arrives as an arbitrary string from
 * the wire (parseRequestLine does not constrain its format); safety relies on
 * this switch matching only literal case labels and returning `undefined` for
 * anything else (callers then reject with ERR_UNKNOWN_OP). Never index,
 * resolve, or interpolate `op` into paths, imports, or command names.
 */
export async function handleIntegrationControlOp(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind === "operator") {
    ioLog.info("operator action", {
      op: req.op,
      operatorId: principal.operatorId,
    });
  }
  switch (req.op) {
    case "acpx_bind_get":
      return handleAcpxBindGet(req, principal, ctx);
    case "acpx_bind_set":
      return handleAcpxBindSet(req, principal, ctx);
    case "acpx_bind_delete":
      return handleAcpxBindDelete(req, principal, ctx);
    case "acpx_bind_list":
      return handleAcpxBindList(req, principal, ctx);
    case "acpx_agent_start":
      return handleAcpxAgentStart(req, principal, ctx);
    case "acpx_agent_stop":
      return handleAcpxAgentStop(req, principal, ctx);
    case "acpx_agent_list":
      return handleAcpxAgentList(req, principal, ctx);

    case "session_context_new":
      return handleSessionContextNew(req, principal, ctx);
    case "session_context_reset":
      return handleSessionContextReset(req, principal, ctx);
    case "session_compact":
      return handleSessionCompact(req, principal, ctx);

    case "hitl_pending_list":
      return handleHitlPendingList(req, principal, ctx);
    case "hitl_pending_get":
      return handleHitlPendingGet(req, principal, ctx);
    case "hitl_pending_approve":
      return handleHitlPendingApprove(req, principal, ctx);
    case "hitl_pending_deny":
      return handleHitlPendingDeny(req, principal, ctx);
    case "hitl_clear":
      return handleHitlClear(req, principal, ctx);
    case "hitl_cruise_control":
      return handleHitlCruiseControl(req, principal, ctx);

    case "mcp_http_cancel_request":
      return handleMcpHttpCancelRequest(req, principal, ctx);

    case "subagent_spawn":
      return handleSubagentSpawn(req, principal, ctx);

    case "subagent_wait":
      return handleSubagentWait(req, principal, ctx);
    case "subagent_result":
      return handleSubagentResult(req, principal, ctx);
    case "session_list":
      return handleSessionList(req, principal, ctx);
    case "session_context_status":
      return handleSessionContextStatus(req, principal, ctx);
    case "session_inspect":
      return handleSessionInspect(req, principal, ctx);
    case "session_send":
      return handleSessionSend(req, principal, ctx);
    case "session_steer":
      return handleSessionSteer(req, principal, ctx);
    case "prompt":
      return handlePrompt(req, principal, ctx);
    case "prompt_list":
      return handlePromptList(req, principal, ctx);

    case "session_abort":
      return handleSessionAbort(req, principal, ctx);
    case "session_kill":
      return handleSessionKill(req, principal, ctx);
    case "session_model":
      return handleSessionModel(req, principal, ctx);
    case "config_show":
      return handleConfigShow(req, principal, ctx);
    case "procman_list":
      return handleProcmanList(req, principal, ctx);
    case "procman_restart":
      return handleProcmanRestart(req, principal, ctx);
    case "procman_stop":
      return handleProcmanStop(req, principal, ctx);
    case "config_request":
      return handleConfigRequest(req, principal, ctx);

    case "session_queue_manage":
      return handleSessionQueueManage(req, principal, ctx);
    case "elevation_grant":
      return handleElevationGrant(req, principal, ctx);
    case "elevation_revoke":
      return handleElevationRevoke(req, principal, ctx);
    case "elevation_list":
      return handleElevationList(req, principal, ctx);
    case "yolo_mode":
      return handleYoloMode(req, principal, ctx);

    case "vault.set":
      return handleVaultSet(req, principal, ctx);
    case "vault.get":
      return handleVaultGet(req, principal, ctx);
    case "vault.delete":
      return handleVaultDelete(req, principal, ctx);
    case "vault.list":
      return handleVaultList(req, principal, ctx);
    case "vault.import":
      return handleVaultImport(req, principal, ctx);
    case "vault.rotate-key":
      return handleVaultRotateKey(req, principal, ctx);

    case "service.list":
      return handleServiceList(req, principal, ctx);
    case "service.requests":
      return handleServiceRequests(req, principal, ctx);
    case "service.request":
      return handleServiceRequest(req, principal, ctx);
    case "service.approve":
      return handleServiceApprove(req, principal, ctx);
    case "service.revoke":
      return handleServiceRevoke(req, principal, ctx);
    case "service.rotate-key":
      return handleServiceRotateKey(req, principal, ctx);

    case "media_generate":
      return handleMediaGenerate(req, principal, ctx);
    case "media_generate_poll":
      return handleMediaGeneratePoll(req, principal, ctx);

    case "decision_evaluate":
      return handleDecisionEvaluate(req, principal, ctx);
    case "rerank_documents":
      return handleRerankDocuments(req, principal, ctx);

    default:
      return undefined;
  }
}
