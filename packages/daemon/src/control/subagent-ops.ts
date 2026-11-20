/**
 * Control plane subagent operations: `subagent_spawn`, `subagent_wait`, and
 * `subagent_result`.
 *
 * Extracted verbatim from `integration-ops.ts` (case bodies byte-for-byte;
 * every error message, audit action, and kill reason preserved).
 */

import { WIRE_VERSION } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type { ShoggothConfig, ShoggothContractEntry } from "@shoggoth/shared";
import {
  agentMayInvokeSubagentSpawnByAllowlist,
  assertValidSubagentAgentId,
  clampTtlMs,
  effectiveMaxSpawnDepth,
  maySpawnSubagentAtDepth,
  parseAgentSessionUrn,
  resolveEffectiveModelsConfig,
  resolveMaxOneShotTtlMs,
  resolveMaxTtlMs,
} from "@shoggoth/shared";
import type { SessionStore } from "../sessions/session-store";
import { computeSessionDepthFromStore } from "../sessions/session-store";
import { getLogger } from "../logging";
import { resolveConfiguredSubagentModel } from "../config/effective-runtime";
import { mergeSubagentSpawnModelSelection } from "@shoggoth/models";
import {
  armPersistentSubagentInactivityTimer,
  clearPersistentSubagentInactivityTimer,
} from "../subagent/persistent-subagent-timers";
import { enableToolsForSession } from "../sessions/session-tool-discovery";
import { validateModelRefExists } from "../sessions/model-resolution";
import { getSubagentHandles, rememberSubagentHandles } from "../subagent/subagent-disposables";
import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { sessionCreds } from "../sessions/session-agent-turn";
import { terminatePersistentSubagentSession } from "../subagent/subagent-kill";
import { markOneShotResultDelivered } from "../subagent/one-shot-final-result";
import { settleOneShotAfterTurn } from "../subagent/one-shot-notify-drain";
import {
  buildThreadSubagentCreatedBanner,
  findAdoptableThreadSubagentSession,
} from "../subagent/thread-subagent-autocreate";
import {
  claimPendingThreadCreationForSpawn,
  claimPlatformThreadIdForSpawn,
} from "../subagent/thread-subagent-claims";
import { extractLatestTranscriptAssistantText } from "../sessions/transcript-to-chat";
import { pushSystemContext } from "../sessions/system-context-buffer";
import {
  CONTRACT_YES_MINIMUM_DEFAULT,
  captureGitHead,
  contractInstruction,
  parseContract,
  validateContractRepository,
  verifyContract,
  type ContractCreds,
  type ContractStatus,
} from "../subagent/contract";
import { SessionManagerError } from "../sessions/session-manager";
import {
  deliverOneShotTtlExpiredFailure,
  deliverSubagentResult,
  terminateOneShotAfterTtl,
  ONE_SHOT_TTL_EXPIRED_CODE,
} from "./ops-shared";
import {
  payloadObject,
  requireString,
  optionalFinitePositiveInt,
  optionalRecordObject,
  optionalStringArray,
  requireSubagentRuntime,
  assertAgentMayUseSubagentSessionOps,
} from "./ops-shared";
import { handleIntegrationControlOp, type IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";

/** Completed entry for one `subagent_wait` target. */
export interface SubagentWaitResolved {
  sessionId: string;
  status: string;
  exitReason: string;
  result?: string;
  truncated?: boolean;
}

/**
 * Resolve one `subagent_wait` target: a terminated (or missing) session yields
 * its completion entry — with the latest transcript result attached when
 * results are requested — and a still-running session yields `null`. Shared by
 * the pre-check sweep and the poll loop in `subagent_wait`.
 */
export function resolveWaitedSessionResult(
  ctx: IntegrationOpsContext,
  sessions: NonNullable<IntegrationOpsContext["sessions"]>,
  sid: string,
  options: { readonly includeResults: boolean; readonly maxCharsEach: number },
): SubagentWaitResolved | null {
  const row = sessions.getById(sid);
  if (!row) {
    const resolved: SubagentWaitResolved = {
      sessionId: sid,
      status: "done",
      exitReason: "not_found",
    };
    if (options.includeResults) {
      Object.assign(resolved, { result: "", truncated: false });
    }
    return resolved;
  }
  if (row.status !== "terminated") {
    return null; // still running
  }
  const resolved: SubagentWaitResolved = {
    sessionId: sid,
    status: "done",
    exitReason: "natural",
  };
  if (options.includeResults) {
    if (ctx.stateDb) {
      const text =
        extractLatestTranscriptAssistantText(ctx.stateDb, sid, row.contextSegmentId) ?? "";
      const truncated = text.length > options.maxCharsEach;
      Object.assign(resolved, {
        result: truncated ? text.slice(0, options.maxCharsEach) : text,
        truncated,
      });
    } else {
      Object.assign(resolved, { result: "", truncated: false });
    }
  }
  return resolved;
}

/**
 * Agents may spawn subagents under their own session id only, and only while
 * their session's depth in the subagent tree is below `maxSpawnDepth` (default 1:
 * top-level sessions may spawn, subagents may not; `0` disables spawning entirely).
 * Depth is computed by walking `parent_session_id` lineage; an unresolvable lineage
 * is treated as "deny". This is the sole spawn-permission + depth gate for agents;
 * it runs *after* the `subagentSpawnAllow` allowlist check and never widens it.
 */
function assertAgentMayUseSubagentSpawn(
  principal: AuthenticatedPrincipal,
  parentSessionId: string,
  sessions: SessionStore,
  config: ShoggothConfig,
): void {
  if (principal.kind !== "agent") return;
  if (principal.sessionId !== parentSessionId) {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "agent may only spawn subagents with parent_session_id equal to own session",
    );
  }
  const row = sessions.getById(principal.sessionId);
  if (!row || row.status === "terminated") {
    throw new IntegrationOpError(
      "ERR_PARENT_SESSION_INVALID",
      "parent session is missing or terminated",
    );
  }
  /*
   * Thread-bound persistent subagents are subject to this gate like any other
   * session: pure `parent_session_id` lineage depth, no platform-thread carve-outs.
   * They were previously exempt from the nesting ban; `maxSpawnDepth` now governs
   * them uniformly.
   */
  const depth = computeSessionDepthFromStore(sessions, principal.sessionId);
  const maxDepth = effectiveMaxSpawnDepth(
    config,
    parseAgentSessionUrn(principal.sessionId)?.agentId,
  );
  if (!maySpawnSubagentAtDepth(depth, maxDepth)) {
    throw new IntegrationOpError(
      "ERR_SUBAGENT_NESTING_FORBIDDEN",
      `subagent spawn denied: nesting depth limit reached (maxSpawnDepth: ${maxDepth})`,
    );
  }
}

/**
 * Handle subagent_spawn control operation.
 */
export async function handleSubagentSpawn(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    if (principal.kind !== "operator" && principal.kind !== "agent") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "subagent_spawn requires operator or agent principal",
      );
    }
    if (principal.kind === "agent") {
      const callerAgentId = parseAgentSessionUrn(principal.sessionId)?.agentId;
      if (callerAgentId && !agentMayInvokeSubagentSpawnByAllowlist(ctx.config, callerAgentId)) {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "subagent_spawn denied for this agent id (subagentSpawnAllow)",
        );
      }
    }
    const ext = subagentRuntimeExtensionRef.current;
    if (!ext) {
      throw new IntegrationOpError(
        "ERR_SUBAGENT_RUNTIME_UNAVAILABLE",
        "subagent runtime not configured (start messaging platform)",
      );
    }
    const { sessions, sessionManager } = requireSubagentRuntime(ctx);
    const pl = payloadObject(req);
    const parentSessionId = requireString(pl, "parent_session_id");
    assertAgentMayUseSubagentSpawn(principal, parentSessionId, sessions, ctx.config);
    let prompt = requireString(pl, "prompt");
    const agentIdRaw = pl.agent_id;
    const reservedAgentIds = new Set(Object.keys(ctx.config.agents?.list ?? {}));
    const parentAgentIdForSubagent = parseAgentSessionUrn(parentSessionId)?.agentId;
    if (parentAgentIdForSubagent) reservedAgentIds.add(parentAgentIdForSubagent);
    for (const row of sessions.list())
      if (row.status !== "terminated" && row.subagentAgentId)
        reservedAgentIds.add(row.subagentAgentId);
    let childAgentId: string;
    if (typeof agentIdRaw === "string" && agentIdRaw.trim()) {
      try {
        assertValidSubagentAgentId(agentIdRaw);
      } catch (e) {
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          e instanceof Error ? e.message : String(e),
        );
      }
      childAgentId = agentIdRaw;
      if (reservedAgentIds.has(childAgentId))
        throw new IntegrationOpError(
          "ERR_SUBAGENT_AGENT_ID_CONFLICT",
          `subagent agent id ${JSON.stringify(childAgentId)} is already in use`,
        );
    } else {
      throw new IntegrationOpError(
        "ERR_SUBAGENT_AGENT_ID_REQUIRED",
        "payload.agent_id is required for subagent_spawn",
      );
    }
    const modeRaw = requireString(pl, "mode");
    if (modeRaw !== "one_shot" && modeRaw !== "persistent") {
      throw new IntegrationOpError(
        "ERR_INVALID_PAYLOAD",
        "payload.mode must be one_shot or persistent",
      );
    }
    // `ttl_minutes` (one-shot wall-clock TTL): validated before the child
    // session exists so an invalid value can never strand a freshly spawned
    // child — one-shot sessions are not covered by the startup reconcile.
    const oneShotTtlMinutes =
      modeRaw === "one_shot" ? optionalFinitePositiveInt(pl, "ttl_minutes") : undefined;
    const parent = sessions.getById(parentSessionId);
    if (!parent || parent.status === "terminated") {
      throw new IntegrationOpError(
        "ERR_PARENT_SESSION_INVALID",
        "parent session is missing or terminated",
      );
    }
    const modelOptions = optionalRecordObject(pl, "model_options");

    /*
     * Contract mode (one-shot only): an optional list of target files with
     * the required modification type and a brief expectation. Validation
     * runs BEFORE the child session exists so a target outside a git
     * repository (or a malformed entry) fails the spawn and notifies the
     * agent. An unset/empty contract leaves the mode inactive.
     */
    let contract: ShoggothContractEntry[] | undefined;
    let contractRepoDir: string | undefined;
    let contractBaselineRef: string | undefined;
    let contractCreds: ContractCreds | undefined;
    if (pl.contract !== undefined && pl.contract !== null) {
      if (modeRaw !== "one_shot") {
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          "contract is only supported for one_shot subagent spawns",
        );
      }
      try {
        contract = parseContract(pl.contract);
      } catch (e) {
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (contract) {
      /*
       * Contract paths resolve against where the session actually lives: an
       * explicit `cd` working directory, else the agent workspace root. The
       * daemon's own cwd (`/app` in a container) must never enter the
       * resolution — it is not the session's directory, so a check against
       * it can only ever report ERR_CONTRACT_NOT_IN_REPO.
       */
      const parentWorkingDirectory = parent.workingDirectory ?? parent.workspacePath;
      // Contract git runs with the parent session's runtime creds so the
      // checks read the same workspace the agent session owns — not the
      // daemon's own uid.
      contractCreds = sessionCreds(parent.runtimeUid, parent.runtimeGid);
      // The child sees its own contract in the task prompt (see the tool
      // descriptor) — it must not be restated in the prompt body.
      prompt += `\n\n${contractInstruction(contract, parentWorkingDirectory)}`;
      const check = validateContractRepository(parentWorkingDirectory, contract, contractCreds);
      if (!check.ok || !check.repoDir) {
        throw new IntegrationOpError(
          "ERR_CONTRACT_NOT_IN_REPO",
          check.error ?? "contract target is not in a git repository",
        );
      }
      contractRepoDir = check.repoDir;
      // Baseline for the post-turn diff: HEAD at spawn time (the "source
      // branch" is the state the subagent is expected to modify). Captured
      // now so mid-turn commits by the subagent still count.
      try {
        contractBaselineRef = captureGitHead(contractRepoDir, contractCreds);
      } catch {
        throw new IntegrationOpError(
          "ERR_CONTRACT_NOT_IN_REPO",
          "contract repository has no HEAD to diff against",
        );
      }
    }

    // `judge`: explicit decision model (provider-id/model-name) for contract
    // judging. Validated against the decision config at call time; unset
    // falls back to agents.contract.model, then the decision default model.
    let judgeModel: string | undefined;
    if (typeof pl.judge === "string" && pl.judge.trim()) {
      if (!contract) {
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "judge requires a non-empty contract");
      }
      const ref = pl.judge.trim();
      const slash = ref.indexOf("/");
      const providerId = slash > 0 ? ref.slice(0, slash) : "";
      const modelName = slash > 0 && slash < ref.length - 1 ? ref.slice(slash + 1) : "";
      const provider = providerId
        ? (
            ctx.config.decision?.providers as
              | Record<string, { models?: Record<string, unknown> }>
              | undefined
          )?.[providerId]
        : undefined;
      if (!provider || !provider.models?.[modelName]) {
        throw new IntegrationOpError(
          "ERR_INVALID_JUDGE",
          `judge model is not a configured decision provider/model: ${ref}`,
        );
      }
      judgeModel = ref;
    }

    // Resolve effective subagentModel from config (per-agent override > global default).
    // Only applies when per-spawn model_options doesn't already set a model.
    let effectiveBase = parent.modelSelection;
    const hasSpawnModel =
      modelOptions && typeof modelOptions.model === "string" && modelOptions.model.trim();
    const parentAgentId = parseAgentSessionUrn(parentSessionId)?.agentId;
    const configSubagentModel = resolveConfiguredSubagentModel(ctx.config, parentAgentId);
    if (!hasSpawnModel) {
      if (configSubagentModel) {
        const base =
          effectiveBase && typeof effectiveBase === "object" && !Array.isArray(effectiveBase)
            ? { ...(effectiveBase as Record<string, unknown>) }
            : {};
        base.model = configSubagentModel;
        effectiveBase = base;
      }
    }

    // Determine explicit model ref: spawn model_options.model > config subagentModel > undefined (inherit as-is).
    const explicitModelRef = hasSpawnModel
      ? String(modelOptions!.model).trim()
      : (configSubagentModel ?? undefined);

    // Validate the explicit model ref against configured providers/models.
    if (explicitModelRef) {
      const effectiveModels =
        resolveEffectiveModelsConfig(ctx.config, parentSessionId) ?? ctx.config.models;
      const result = validateModelRefExists(effectiveModels, explicitModelRef);
      if (!result.ok) {
        const code = result.error.includes("must be in providerId/model format")
          ? "ERR_INVALID_MODEL"
          : "ERR_MODEL_NOT_FOUND";
        throw new IntegrationOpError(code, result.error);
      }
    }

    const modelSelection = mergeSubagentSpawnModelSelection(
      effectiveBase,
      modelOptions,
      explicitModelRef,
    );

    // Optional response delivery routing (defaults: respondTo = parent, internal = true).
    const respondToRaw = pl.respond_to;
    const explicitRespondTo =
      typeof respondToRaw === "string" && respondToRaw.trim() ? respondToRaw.trim() : undefined;
    const respondTo = explicitRespondTo ?? parentSessionId;
    if (explicitRespondTo) {
      // Fail fast on a dead delivery target: otherwise the completion result has
      // nowhere to land and the loss only surfaces hours later (see #455).
      const respondToRow = sessions.getById(explicitRespondTo);
      if (!respondToRow || respondToRow.status === "terminated") {
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          `respond_to session is missing or terminated: ${explicitRespondTo}`,
        );
      }
    }
    const internalDelivery = pl.internal !== false; // default true
    const deliveryModeRaw = pl.delivery_mode;
    const deliveryMode: "inline" | "queue" | "drop" =
      deliveryModeRaw === "queue" || deliveryModeRaw === "drop" ? deliveryModeRaw : "inline";

    // Spawn-time tool enables: exact tool IDs or glob patterns (e.g. "kanban-*"),
    // merged into the child session's tool state alongside configured defaults.
    const enableTools = optionalStringArray(pl, "enable_tools");
    /*
     * Persistent-mode thread target: resolve (and for the `"0"` sentinel, create) the
     * platform thread BEFORE the child session exists, so a resolution failure never
     * strands a spawned session, and claim the target so the platform's thread-create
     * event cannot race this op for the binding (see thread-subagent-claims).
     */
    let platformThreadId: string | undefined;
    let releaseThreadClaim: () => void = () => {};
    if (modeRaw === "persistent") {
      const platformThreadIdRaw = pl.platform_thread_id;
      const rawTrimmed =
        typeof platformThreadIdRaw === "string" && platformThreadIdRaw.trim()
          ? platformThreadIdRaw.trim()
          : undefined;
      if (rawTrimmed === "0") {
        // Sentinel: auto-create a standalone thread in the parent session's channel.
        const parentChannelId = ext.resolveOutboundChannelIdForSession?.(parentSessionId);
        if (!parentChannelId) {
          throw new IntegrationOpError(
            "ERR_INVALID_PAYLOAD",
            "cannot create thread: parent session has no bound channel",
          );
        }
        const threadNameRaw = pl.thread_name;
        const threadName =
          typeof threadNameRaw === "string" && threadNameRaw.trim()
            ? threadNameRaw.trim()
            : prompt.slice(0, 100);
        if (!ext.createThread) {
          throw new IntegrationOpError(
            "ERR_SUBAGENT_RUNTIME_UNAVAILABLE",
            "createThread not available on subagent runtime extension",
          );
        }
        // Claim the pending creation by channel: the id does not exist until the REST
        // call returns, but the gateway THREAD_CREATE event may be dispatched before it
        // does — the autocreate routine checks this claim and skips.
        releaseThreadClaim = claimPendingThreadCreationForSpawn(parentChannelId);
        let created: { readonly id: string };
        try {
          created = await ext.createThread(parentChannelId, { name: threadName, type: 11 });
        } catch (e) {
          releaseThreadClaim();
          throw e;
        }
        platformThreadId = created.id;
        try {
          releaseThreadClaim();
          releaseThreadClaim = claimPlatformThreadIdForSpawn(platformThreadId);
        } catch (e) {
          releaseThreadClaim();
          throw new IntegrationOpError(
            "ERR_INVALID_PAYLOAD",
            `thread ${platformThreadId} is already claimed by an in-flight spawn (${String(e)})`,
          );
        }
      } else {
        platformThreadId = rawTrimmed;
        if (platformThreadId) {
          try {
            releaseThreadClaim = claimPlatformThreadIdForSpawn(platformThreadId);
          } catch (e) {
            releaseThreadClaim();
            throw new IntegrationOpError(
              "ERR_INVALID_PAYLOAD",
              `thread ${platformThreadId} is already claimed by an in-flight spawn (${String(e)})`,
            );
          }
        }
      }
    }

    let childId: string;
    try {
      ({ sessionId: childId } = await sessionManager.spawn({
        parentSessionId,
        parentWorkingDirectory: parent.workingDirectory,
        subagentAgentId: childAgentId,
        ...(modelSelection !== undefined ? { modelSelection } : {}),
      }));
    } catch (e) {
      // Spawn failed after a thread claim may already be held: release it so a failed
      // spawn never leaves a poisoned claim behind.
      releaseThreadClaim();
      if (e instanceof SessionManagerError) {
        throw new IntegrationOpError(e.code, e.message);
      }
      throw e;
    }
    if (enableTools && enableTools.length > 0 && ctx.stateDb) {
      enableToolsForSession(ctx.stateDb, childId, enableTools);
    }
    if (modeRaw === "one_shot") {
      /*
       * `ttl_minutes` (if provided) is the wall-clock lifetime: the child is
       * terminated when the deadline fires. The deadline is absolute — one-shot
       * turns are non-resumable, so unlike the persistent inactivity clock there
       * is nothing to reset. It is never "forever": an absent `ttl_minutes`
       * defaults to the tiered one-shot ceiling, and a provided value is
       * capped at that same ceiling, so the persisted expiry below is always
       * finite. The ceiling is `runtime.maxOneShotTtlMs` when set (clamped
       * down to `runtime.maxTtlMs`, which remains the global cap), falling
       * back to `runtime.maxTtlMs` when that tier is unset.
       */
      const maxTtlMs = resolveMaxOneShotTtlMs(ctx.config);
      const oneShotTtlMs = clampTtlMs(
        oneShotTtlMinutes !== undefined ? oneShotTtlMinutes * 60_000 : undefined,
        maxTtlMs,
      );
      const oneShotExpiresAtMs = Date.now() + oneShotTtlMs;
      sessions.update(childId, {
        parentSessionId,
        subagentMode: "one_shot",
        subagentPlatformThreadId: null,
        subagentExpiresAtMs: oneShotExpiresAtMs,
        // Persisted so the teardown's final-result delivery resolves the same
        // target the spawn path used (a one-shot may steer its reply at a
        // respond_to that is not the spawning session).
        subagentDeliveryMode: deliveryMode,
        subagentRespondTo: respondTo,
      });
      const subLog = getLogger("subagent");
      subLog.info("subagent one_shot model turn starting", {
        childId,
        agentId: childAgentId,
        parentSessionId,
        promptLen: prompt.length,
      });
      pushSystemContext(childId, "One-shot subagent task spawned by parent session.");
      /*
       * Contract mode: verify after the turn that every target was acted
       * upon with its contractual type, then judge each resulting diff with
       * the decision model in batches. A broken contract or any "yes"
       * below agents.contract.yesMinimum marks the contract unfulfilled.
       */
      const runContractDecision = async (req: {
        state: unknown;
        questions: Record<string, unknown>;
        model?: string;
      }): Promise<Record<string, unknown>> => {
        const res = await handleIntegrationControlOp(
          {
            v: WIRE_VERSION,
            id: `contract-${Date.now()}`,
            op: "decision_evaluate",
            auth: { kind: "agent", session_id: childId, token: "" },
            payload: {
              ...(req.model ? { model: req.model } : {}),
              state: req.state,
              questions: req.questions,
            },
          },
          principal,
          ctx,
        );
        if (res === undefined) {
          // Feature gating: decision_evaluate returns undefined when no
          // decision provider with models is configured.
          return { error: "decision model not configured" };
        }
        if (res && typeof res === "object" && "error" in res) {
          return { error: String((res as { error: unknown }).error) };
        }
        if (res && typeof res === "object" && "answers" in res) {
          const wrapped = res as { status?: string; answers?: unknown };
          if (wrapped.status !== "complete") {
            return { error: `decision status: ${wrapped.status ?? "unknown"}` };
          }
          return (wrapped.answers ?? {}) as Record<string, unknown>;
        }
        return (res ?? {}) as Record<string, unknown>;
      };
      const judgeContract = async (): Promise<ContractStatus> => {
        if (!contract) {
          return {
            broken: false,
            yesMinimum: CONTRACT_YES_MINIMUM_DEFAULT,
            entries: [],
            judged: [],
            violated: [],
            deletedSkipped: [],
            baseline: "",
          };
        }
        try {
          return await verifyContract({
            // Same resolution rule as spawn-time validation (see above).
            cwd: parent.workingDirectory ?? parent.workspacePath,
            entries: contract,
            ...(contractBaselineRef ? { sourceBranch: contractBaselineRef } : {}),
            ...(contractCreds ? { creds: contractCreds } : {}),
            config: ctx.config,
            ...(judgeModel ? { judgeModel } : {}),
            runDecision: runContractDecision,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          subLog.warn("contract verification errored", { childId, error: msg });
          return {
            broken: true,
            reason: `verification failed: ${msg}`,
            yesMinimum: CONTRACT_YES_MINIMUM_DEFAULT,
            entries: contract,
            judged: [],
            violated: [],
            deletedSkipped: [],
            baseline: "",
          };
        }
      };
      const backgroundSpawn = pl.background === true;
      if (backgroundSpawn) {
        /*
         * Wall-clock TTL for the fire-and-forget turn: at the absolute deadline
         * the child is terminated, the structured failure is delivered to the
         * spawning session, and any still-pending completion handlers are
         * ignored so a killed child can never surface a spurious result.
         */
        let oneShotTtlFired = false;
        // Outcome of the settling turn, captured for the end-of-turn
        // teardown (a failed/aborted turn never answers its steers).
        let settledOutcome: "completed" | "aborted" | "failed" | "canceled" = "completed";
        const ttlTimer = setTimeout(() => {
          oneShotTtlFired = true;
          subLog.warn("subagent one_shot (background) wall-clock TTL expired", {
            childId,
            ttlMs: oneShotTtlMs,
          });
          terminateOneShotAfterTtl(sessionManager, childId, ctx.hitlClear?.autoApproveGate);
          void deliverOneShotTtlExpiredFailure({
            ext,
            parentSessionId,
            childId,
            childAgentId,
            subLog,
          });
        }, oneShotTtlMs);
        // Fire-and-forget: run the model turn asynchronously and return immediately.
        ext
          .runSessionModelTurn({
            sessionId: childId,
            userContent: prompt,
            userMetadata: {
              subagent_one_shot: true,
              parent_session_id: parentSessionId,
              agent_id: childAgentId,
              respond_to: respondTo,
              internal: internalDelivery,
            },
            systemContext: {
              kind: "subagent.task",
              summary:
                "You are a one-shot subagent. Complete the following task and return the result.",
              data: {
                parent_session_id: parentSessionId,
                agent_id: childAgentId,
                respond_to: respondTo,
                internal: internalDelivery,
              },
            },
            delivery: { kind: "internal" },
          })
          .then(async (turn) => {
            if (oneShotTtlFired) return;
            settledOutcome = turn.outcome;
            subLog.info("subagent one_shot (background) model turn completed", {
              childId,
              replyLen: turn.latestAssistantText?.length ?? 0,
              turnOutcome: turn.outcome,
            });
            if (contract) {
              const contractStatus = await judgeContract();
              subLog.info("subagent contract judged (background)", {
                childId,
                broken: contractStatus.broken,
                ...(contractStatus.reason ? { reason: contractStatus.reason } : {}),
              });
            }
            await deliverSubagentResult(ext, {
              deliveryMode,
              childSessionId: childId,
              childAgentId,
              respondTo,
              internalDelivery,
              mode: "one_shot",
              assistantText: turn.latestAssistantText,
              subLog,
              fallbackRespondTo: parentSessionId,
              onDelivered: () => markOneShotResultDelivered(childId, turn.latestAssistantText),
            });
          })
          .catch((err) => {
            if (oneShotTtlFired) return;
            settledOutcome = "failed";
            subLog.warn("subagent one_shot (background) model turn failed", {
              childId,
              error: String(err),
            });
          })
          .finally(() => {
            clearTimeout(ttlTimer);
            /*
             * Keep the session alive when background execs it started are
             * still pending: the notifications carry the exit codes the
             * subagent must react to. The last handle completion (or the
             * TTL-capped safety timer) settles the teardown. `turnOutcome`
             * lets the settle decide whether the steers this turn received
             * were answered (a turn that aborted or failed never answered
             * them — they are re-delivered before the teardown fires).
             */
            settleOneShotAfterTurn({
              sessionManager,
              sessions,
              stateDb: ctx.stateDb,
              sessionId: childId,
              autoApproveGate: ctx.hitlClear?.autoApproveGate,
              subLog,
              turnOutcome: settledOutcome,
            });
          });
        ctx.recordIntegrationAudit({
          action: "subagent.spawn_one_shot",
          resource: childId,
          outcome: "ok",
          argsRedactedJson: JSON.stringify({
            parent_session_id: parentSessionId,
            agent_id: childAgentId,
            background: true,
          }),
        });
        return {
          session_id: childId,
          agent_id: childAgentId,
          mode: "one_shot",
          background: true,
          respond_to: respondTo,
          internal: internalDelivery,
          ...(contract ? { contract: { active: true, pending: true } } : {}),
        };
      }
      /*
       * Wall-clock TTL for the awaited foreground turn: at the absolute deadline
       * the child is terminated (aborting its in-flight turn) and the awaited
       * race is settled with the structured failure, so the spawn op can never
       * hang past its TTL. The child's turn result is discarded after expiry.
       */
      let oneShotTtlFired = false;
      // Outcome of the settling turn, captured for the end-of-turn teardown
      // (a failed/aborted turn never answers its steers).
      let settledOutcome: "completed" | "aborted" | "failed" | "canceled" = "completed";
      let settleTurn: (() => void) | undefined;
      const ttlTimer = setTimeout(() => {
        oneShotTtlFired = true;
        subLog.warn("subagent one_shot wall-clock TTL expired", {
          childId,
          ttlMs: oneShotTtlMs,
        });
        terminateOneShotAfterTtl(sessionManager, childId, ctx.hitlClear?.autoApproveGate);
        // Deliver the structured failure to the spawning session (the spawn
        // response also carries the same code), then settle the spawn; the
        // killed child's turn drains in the background and its result is dropped.
        void deliverOneShotTtlExpiredFailure({
          ext,
          parentSessionId,
          childId,
          childAgentId,
          subLog,
        });
        settleTurn?.();
      }, oneShotTtlMs);
      let turn: {
        latestAssistantText: string;
        failoverMeta?: unknown;
        outcome: "completed" | "aborted" | "failed" | "canceled";
      };
      try {
        const turnPromise = ext.runSessionModelTurn({
          sessionId: childId,
          userContent: prompt,
          userMetadata: {
            subagent_one_shot: true,
            parent_session_id: parentSessionId,
            agent_id: childAgentId,
            respond_to: respondTo,
            internal: internalDelivery,
          },
          systemContext: {
            kind: "subagent.task",
            summary:
              "You are a one-shot subagent. Complete the following task and return the result.",
            data: {
              parent_session_id: parentSessionId,
              agent_id: childAgentId,
              respond_to: respondTo,
              internal: internalDelivery,
            },
          },
          delivery: { kind: "internal" },
        });
        const settlePromise = new Promise<never>((_, reject) => {
          settleTurn = () =>
            reject(
              new IntegrationOpError(
                ONE_SHOT_TTL_EXPIRED_CODE,
                `one-shot subagent ${childId} terminated at its wall-clock TTL`,
              ),
            );
        });
        turn = await Promise.race([turnPromise, settlePromise]);
        settledOutcome = turn.outcome;
        if (oneShotTtlFired) {
          throw new IntegrationOpError(
            ONE_SHOT_TTL_EXPIRED_CODE,
            `one-shot subagent ${childId} terminated at its wall-clock TTL`,
          );
        }
        subLog.info("subagent one_shot model turn completed", {
          childId,
          replyLen: turn.latestAssistantText?.length ?? 0,
        });
      } catch (e) {
        // Expiry (or the killed turn's abort rejection) surfaces as the
        // structured failure so the spawning session can decide whether to
        // respawn with a larger budget.
        if (
          oneShotTtlFired &&
          !(e instanceof IntegrationOpError && e.code === ONE_SHOT_TTL_EXPIRED_CODE)
        ) {
          throw new IntegrationOpError(
            ONE_SHOT_TTL_EXPIRED_CODE,
            `one-shot subagent ${childId} terminated at its wall-clock TTL`,
          );
        }
        throw e;
      } finally {
        clearTimeout(ttlTimer);
        settleTurn = undefined;
        /*
         * Keep the session alive when background execs it started are still
         * pending: the notifications carry the exit codes the subagent must
         * react to. The last handle completion (or the TTL-capped safety
         * timer) settles the teardown.
         */
        settleOneShotAfterTurn({
          sessionManager,
          sessions,
          stateDb: ctx.stateDb,
          sessionId: childId,
          autoApproveGate: ctx.hitlClear?.autoApproveGate,
          subLog,
          turnOutcome: settledOutcome,
        });
      }
      // Contract mode: judge the turn's diffs against the contract and
      // return the verdict as an extra field on the spawn response.
      let contractStatus: ContractStatus | undefined;
      if (contract) {
        contractStatus = await judgeContract();
        subLog.info("subagent contract judged", {
          childId,
          broken: contractStatus.broken,
          ...(contractStatus.reason ? { reason: contractStatus.reason } : {}),
        });
      }
      ctx.recordIntegrationAudit({
        action: "subagent.spawn_one_shot",
        resource: childId,
        outcome: "ok",
        argsRedactedJson: JSON.stringify({
          parent_session_id: parentSessionId,
          agent_id: childAgentId,
        }),
      });
      if (deliveryMode === "inline") {
        // Inline: the reply IS the op response — mark it as delivered so the
        // teardown's final-result delivery compares against this text.
        markOneShotResultDelivered(childId, turn.latestAssistantText);
        return {
          session_id: childId,
          mode: "one_shot",
          reply: turn.latestAssistantText,
          respond_to: respondTo,
          internal: internalDelivery,
          failover: turn.failoverMeta ?? null,
          ...(contractStatus ? { contract: contractStatus } : {}),
        };
      }
      // queue or drop: route through deliverSubagentResult, suppress reply in response
      await deliverSubagentResult(ext, {
        deliveryMode,
        childSessionId: childId,
        childAgentId,
        respondTo,
        internalDelivery,
        mode: "one_shot",
        assistantText: turn.latestAssistantText,
        subLog,
        fallbackRespondTo: parentSessionId,
        onDelivered: () => markOneShotResultDelivered(childId, turn.latestAssistantText),
      });
      return {
        session_id: childId,
        mode: "one_shot",
        respond_to: respondTo,
        internal: internalDelivery,
        delivery_mode: deliveryMode,
        ...(contractStatus ? { contract: contractStatus } : {}),
      };
    }
    /*
     * `inactivity_minutes` (if provided) is the inactivity window: the session is
     * terminated after this long without a delivered assistant response. The clock
     * resets on every delivered response (touchPersistentSubagentInactivityTimer),
     * and the computed expiry is persisted so restart reconcile re-arms it correctly.
     *
     * The window is never "forever": when `inactivity_minutes` is absent it defaults
     * to the configured max TTL, and a provided value is capped at that same max TTL
     * (see #439). With the default max TTL (24h) this matches the prior 1440-minute
     * default; an operator lowering `runtime.maxTtlMs` shrinks both the default and
     * the ceiling together.
     */
    const maxTtlMs = resolveMaxTtlMs(ctx.config);
    const providedMinutes = optionalFinitePositiveInt(pl, "inactivity_minutes");
    const inactivityMinutes = Math.max(
      1,
      Math.round(
        clampTtlMs(providedMinutes !== undefined ? providedMinutes * 60_000 : undefined, maxTtlMs) /
          60_000,
      ),
    );
    const platformUserIdRaw = pl.platform_user_id;
    const platformUserId =
      typeof platformUserIdRaw === "string" && platformUserIdRaw.trim()
        ? platformUserIdRaw.trim()
        : undefined;
    const replyToMessageId =
      typeof pl.reply_to_message_id === "string" && pl.reply_to_message_id.trim()
        ? pl.reply_to_message_id.trim()
        : undefined;
    sessions.update(childId, {
      parentSessionId,
      subagentMode: "persistent",
      subagentPlatformThreadId: platformThreadId ?? null,
      subagentDeliveryMode: deliveryMode,
      subagentRespondTo: respondTo,
    });
    let unregisterThread: () => void;
    let adoptedSessionId: string | undefined;
    try {
      unregisterThread = platformThreadId
        ? ext.registerPlatformThreadBinding(platformThreadId, childId)
        : () => {};
    } catch (bindErr) {
      /*
       * The thread is already bound: normally a conflict with a concurrent flow, so
       * terminate this child and surface it to the caller. But the platform's
       * thread-create autocreate routine may have won the thread in the window between
       * this op's claim and its bind (or before the claim for auto-created threads):
       * when the holder is a freshly autocreated, zero-turn banner-only session under
       * this parent, ADOPT it — deliver the spawn prompt as its first turn instead of
       * failing the spawn and leaving a banner-only zombie behind.
       */
      const adoptable =
        platformThreadId && ctx.stateDb
          ? findAdoptableThreadSubagentSession({
              sessions,
              db: ctx.stateDb,
              threadId: platformThreadId,
              parentSessionId,
              excludeSessionId: childId,
            })
          : undefined;
      if (adoptable) {
        adoptedSessionId = adoptable.id;
        // The adoptee won the race, so its runtime handles are registered: reuse its
        // live thread binding for this spawn.
        unregisterThread = getSubagentHandles(adoptable.id)?.unregisterThread ?? (() => {});
        // The spawn's own child must not linger as an orphan claiming the thread.
        sessions.update(childId, { subagentPlatformThreadId: null, subagentExpiresAtMs: null });
        getLogger("subagent").info("thread_subagent.spawn_adopted_autocreated", {
          childId,
          adoptedSessionId: adoptable.id,
          platformThreadId,
        });
      } else {
        // No adoptable session: this thread genuinely belongs to another active
        // session. Release the claim and terminate this child so no orphan session
        // lingers, then surface the conflict to the caller.
        releaseThreadClaim();
        try {
          sessionManager.kill(childId);
        } catch {
          /* best-effort cleanup */
        }
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          `thread ${platformThreadId} is already bound to another active session; terminate it before binding a new subagent (${String(bindErr)})`,
        );
      }
    }
    const subLog = getLogger("subagent");
    let expiresAtMs: number;
    if (adoptedSessionId) {
      /*
       * Take over the adoptee's runtime: it was fully wired by the autocreate routine
       * (binding, bus subscription, inactivity clock). Refresh the clock against this
       * spawn's window, keep its live handles, then discard the spawn's own child so it
       * cannot linger as an orphan.
       */
      const adoptedHandles = getSubagentHandles(adoptedSessionId);
      clearPersistentSubagentInactivityTimer(adoptedSessionId);
      const adoptedTtl = armPersistentSubagentInactivityTimer(
        {
          sessions,
          onTimeout: (sid) => {
            terminatePersistentSubagentSession(
              sessionManager,
              sid,
              "ttl_expired",
              ctx.hitlClear?.autoApproveGate,
              "adopted_spawn_inactivity",
            );
          },
        },
        adoptedSessionId,
        { timeoutMs: inactivityMinutes * 60_000 },
      );
      rememberSubagentHandles(adoptedSessionId, {
        unregisterThread,
        unsubscribeBus: adoptedHandles?.unsubscribeBus ?? (() => {}),
        clearTtl: adoptedTtl.dispose,
      });
      expiresAtMs = adoptedTtl.expiresAtMs;
      try {
        sessionManager.kill(childId);
      } catch {
        /* best-effort cleanup */
      }
    } else {
      const unsubscribeBus = ext.subscribeSubagentSession(childId);
      // Arm the shared inactivity clock (persists subagentExpiresAtMs, reset on each
      // delivered response). Applies uniformly to thread-bound and threadless spawns.
      const armed = armPersistentSubagentInactivityTimer(
        {
          sessions,
          onTimeout: (sid) => {
            terminatePersistentSubagentSession(
              sessionManager,
              sid,
              "ttl_expired",
              ctx.hitlClear?.autoApproveGate,
              "persistent_spawn_inactivity",
            );
          },
        },
        childId,
        { timeoutMs: inactivityMinutes * 60_000 },
      );
      expiresAtMs = armed.expiresAtMs;
      rememberSubagentHandles(childId, {
        unregisterThread,
        unsubscribeBus,
        clearTtl: armed.dispose,
      });
    }
    // The claim protects the thread only until this op owns the binding (or adoption
    // completes); released on every exit path, including thrown errors above.
    releaseThreadClaim();
    const turnSessionId = adoptedSessionId ?? childId;
    const delivery = platformThreadId
      ? (() => {
          // Thread-bound subagent: platform resolves channel from thread binding,
          // so platform_user_id is optional.
          return {
            kind: "messaging_surface",
            userId: platformUserId ?? "system",
            replyToMessageId,
          } as const;
        })()
      : ({ kind: "internal" } as const);
    /*
     * Fire the first model turn asynchronously so the parent is not blocked.
     * Creation banner: thread-bound spawns post it BEFORE the first model turn
     * so the thread reads creation → response, matching the automatic
     * thread-create path. Skipped for an adopted session — the autocreate routine
     * already posted its creation banner. Best-effort: a failed banner never blocks the spawn.
     */
    if (platformThreadId && !adoptedSessionId && ext.sendStatusMessage && ctx.stateDb) {
      try {
        await ext.sendStatusMessage(
          childId,
          buildThreadSubagentCreatedBanner({
            db: ctx.stateDb,
            config: ctx.config,
            sessionId: childId,
            logger: subLog,
          }),
        );
      } catch (e) {
        subLog.warn("thread_subagent.status_send_failed", {
          sessionId: childId,
          agentId: childAgentId,
          platformThreadId,
          err: String(e),
        });
      }
    }
    ext
      .runSessionModelTurn({
        sessionId: turnSessionId,
        userContent: prompt,
        userMetadata: {
          subagent_persistent: true,
          parent_session_id: parentSessionId,
          agent_id: childAgentId,
          platform_thread_id: platformThreadId ?? null,
          respond_to: respondTo,
          internal: internalDelivery,
        },
        systemContext: {
          kind: "subagent.task",
          summary: "You are a persistent subagent session. Complete the following task.",
          data: {
            parent_session_id: parentSessionId,
            agent_id: childAgentId,
            respond_to: respondTo,
            platform_thread_id: platformThreadId ?? null,
            internal: internalDelivery,
          },
        },
        delivery,
      })
      .then((turn) => {
        // Deliver result to respond_to session for non-thread-bound persistent subagents.
        if (!platformThreadId) {
          return deliverSubagentResult(ext, {
            deliveryMode,
            childSessionId: turnSessionId,
            respondTo,
            internalDelivery,
            mode: "persistent",
            assistantText: turn.latestAssistantText,
            subLog,
            fallbackRespondTo: parentSessionId,
          });
        }
      })
      .catch((err) => {
        subLog.warn("persistent subagent first turn failed", {
          childId: turnSessionId,
          error: String(err),
        });
      });
    ctx.recordIntegrationAudit({
      action: "subagent.spawn_persistent",
      resource: turnSessionId,
      outcome: "ok",
      argsRedactedJson: JSON.stringify({
        parent_session_id: parentSessionId,
        agent_id: childAgentId,
        platform_thread_id: platformThreadId ?? null,
        adopted_session_id: adoptedSessionId ?? null,
        expires_at_ms: expiresAtMs,
      }),
    });
    return {
      // On adoption the banner-only autocreated session is the thread's session of
      // record: it keeps the binding and receives the spawn prompt as its first turn.
      session_id: turnSessionId,
      mode: "persistent",
      platform_thread_id: platformThreadId ?? null,
      expires_at_ms: expiresAtMs,
      respond_to: respondTo,
      internal: internalDelivery,
      ...(adoptedSessionId ? { adopted_session_id: adoptedSessionId } : {}),
    };
  }
}

/**
 * Handle subagent_wait control operation.
 */
export async function handleSubagentWait(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator" && principal.kind !== "agent") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "subagent_wait requires operator or agent principal",
    );
  }
  if (principal.kind === "agent") {
    assertAgentMayUseSubagentSessionOps(principal, ctx);
  }
  const { sessions } = requireSubagentRuntime(ctx);
  const pl = payloadObject(req);
  const sessionIds = optionalStringArray(pl, "session_ids");
  if (!sessionIds || sessionIds.length === 0) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload.session_ids must be a non-empty array of strings",
    );
  }
  const timeoutMs = optionalFinitePositiveInt(pl, "timeout_ms") ?? 300_000;
  const modeRaw = pl.mode;
  const mode = modeRaw === "any" ? "any" : "all"; // default "all"
  const includeResults = pl.include_results === true;
  const maxCharsEach = optionalFinitePositiveInt(pl, "max_chars") ?? 4000;

  // Validate that agent can only wait on its own direct children.
  if (principal.kind === "agent") {
    for (const sid of sessionIds) {
      const row = sessions.getById(sid);
      if (row && row.parentSessionId !== principal.sessionId) {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          `agent may only wait on direct child subagents (${sid})`,
        );
      }
    }
  }

  const POLL_INTERVAL_MS = optionalFinitePositiveInt(pl, "_poll_interval_ms") ?? 500;
  const deadline = Date.now() + timeoutMs;

  const completed: SubagentWaitResolved[] = [];
  const remaining = new Set(sessionIds);

  // Check for already-completed sessions first.
  for (const sid of sessionIds) {
    const resolved = resolveWaitedSessionResult(ctx, sessions, sid, {
      includeResults,
      maxCharsEach,
    });
    if (resolved) {
      completed.push(resolved);
      remaining.delete(sid);
    }
  }

  // If mode=any and we already have one, or mode=all and all done, return immediately.
  if (remaining.size === 0 || (mode === "any" && completed.length > 0)) {
    return {
      completed,
      pending: [...remaining].map((sid) => ({
        sessionId: sid,
        status: "running",
      })),
      timedOut: false,
    };
  }

  // Poll loop — yield execution between checks.
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    for (const sid of remaining) {
      const resolved = resolveWaitedSessionResult(ctx, sessions, sid, {
        includeResults,
        maxCharsEach,
      });
      if (resolved) {
        completed.push(resolved);
        remaining.delete(sid);
      }
    }
    if (remaining.size === 0 || (mode === "any" && completed.length > 0)) {
      break;
    }
  }

  return {
    completed,
    pending: [...remaining].map((sid) => ({
      sessionId: sid,
      status: "running",
    })),
    timedOut: remaining.size > 0,
  };
}

/**
 * Handle subagent_result control operation.
 */
export async function handleSubagentResult(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator" && principal.kind !== "agent") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "subagent_result requires operator or agent principal",
    );
  }
  if (principal.kind === "agent") {
    assertAgentMayUseSubagentSessionOps(principal, ctx);
  }
  const { sessions } = requireSubagentRuntime(ctx);
  const pl = payloadObject(req);
  const sessionId = requireString(pl, "session_id");
  const maxChars = optionalFinitePositiveInt(pl, "max_chars") ?? 8000;

  // Agent can only read results from direct children.
  if (principal.kind === "agent") {
    const row = sessions.getById(sessionId);
    if (row && row.parentSessionId !== principal.sessionId) {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "agent may only read results from direct child subagents",
      );
    }
  }

  const row = sessions.getById(sessionId);
  if (!row) {
    return {
      sessionId,
      status: "not_found",
      result: null,
      truncated: false,
    };
  }
  if (row.status !== "terminated") {
    return { sessionId, status: "running", result: null, truncated: false };
  }
  if (!ctx.stateDb) {
    throw new IntegrationOpError(
      "ERR_STATE_DB_REQUIRED",
      "subagent_result requires state database",
    );
  }
  const text =
    extractLatestTranscriptAssistantText(ctx.stateDb, sessionId, row.contextSegmentId) ?? "";
  const truncated = text.length > maxChars;
  return {
    sessionId,
    status: "done",
    result: truncated ? text.slice(0, maxChars) : text,
    truncated,
  };
}
