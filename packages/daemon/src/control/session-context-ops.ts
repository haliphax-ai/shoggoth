/**
 * Control plane session context-segment and compaction operations.
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { SessionStore } from "../sessions/session-store";
import type { IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";
import { resolveSessionTargetFromCliArg } from "./resolve-session-cli-target";
import {
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
} from "../sessions/session-context-segment";
import { compactSessionTranscript } from "../transcript-compact";
import { CompactionGateClosedError, pushCompactionRequest } from "../sessions/compaction-gate";
import { runSessionCompaction } from "../sessions/run-session-compaction";
import { tryGetTurnQueue } from "../sessions/session-turn-queue-singleton";
import { TurnDroppedError } from "../sessions/session-turn-queue";
import { terminatePersistentSubagentSession } from "../subagent/subagent-kill";

function payloadObject(req: WireRequest): Record<string, unknown> {
  const p = req.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload must be a JSON object");
  }
  return p as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      `payload.${key} must be a non-empty string`,
    );
  }
  return v;
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

function requireSessionId(
  pl: Record<string, unknown>,
  cfg: ShoggothConfig,
  sessions: SessionStore | undefined,
): string {
  return resolveTargetSessionIdOrThrow(requireString(pl, "session_id"), cfg, sessions);
}

/**
 * Runs a session compaction serialized through the turn queue (a system turn
 * holding the running slot), so it cannot interleave with inbound turns. The
 * captured compaction result is returned even though the queue's promise
 * resolves void; a dropped entry (queue full) surfaces as ERR_SESSION_BUSY.
 * Falls back to running inline when the queue is unavailable (tests).
 */
async function runCompactionBehindQueue(
  ctx: IntegrationOpsContext,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof compactSessionTranscript>>> {
  let captured: Awaited<ReturnType<typeof compactSessionTranscript>> = {
    compacted: false,
    messageCount: 0,
  };
  const queue = tryGetTurnQueue();
  if (!queue) {
    return runSessionCompaction({ db: ctx.stateDb!, sessionId, config: ctx.config });
  }
  await queue
    .enqueue(sessionId, "system", "compaction", async () => {
      captured = await runSessionCompaction({
        db: ctx.stateDb!,
        sessionId,
        config: ctx.config,
      });
    })
    .catch((e: unknown) => {
      if (e instanceof TurnDroppedError) {
        throw new IntegrationOpError("ERR_SESSION_BUSY", "session queue is full");
      }
      throw e;
    });
  return captured;
}

interface SessionContextSegmentOpSpec {
  /** Op name for principal-guard error strings (e.g. "session_context_new"). */
  readonly opName: string;
  /** Audit action recorded on success (e.g. "session.context_segment_new"). */
  readonly auditAction: string;
  /** Kill reason passed through to the subagent kill closure. */
  readonly killReason: string;
  /** Segment mutation to apply (`applySessionContextSegmentNew` / `...Reset`). */
  readonly apply: typeof applySessionContextSegmentNew;
}

/**
 * Shared body of session_context_new / session_context_reset: operator guard,
 * state/manager guard, target resolution, segment mutation with subagent kill
 * wiring, and a success audit record. Per-op behavior (segment mint vs wipe,
 * kill reason, audit action) is carried by the spec.
 */
async function handleSessionContextSegmentOp(
  op: SessionContextSegmentOpSpec,
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", `${op.opName} requires operator principal`);
  }
  if (!ctx.stateDb || !ctx.sessions || !ctx.sessionManager) {
    throw new IntegrationOpError(
      "ERR_STATE_DB_REQUIRED",
      "session context ops require state database and session manager",
    );
  }
  // A session manager is always created alongside the state DB (see control-plane), so one is
  // guaranteed here — captured for the kill closure without a non-null assertion.
  const sessionManager = ctx.sessionManager;
  const pl = payloadObject(req);
  const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);
  const out = op.apply({
    db: ctx.stateDb,
    sessions: ctx.sessions,
    sessionId,
    pending: ctx.hitlPending,
    killSubagents: (childIds) => {
      for (const cid of childIds) {
        terminatePersistentSubagentSession(
          sessionManager,
          cid,
          "killed",
          ctx.hitlClear?.autoApproveGate,
          op.killReason,
        );
      }
    },
  });
  ctx.recordIntegrationAudit({
    action: op.auditAction,
    resource: sessionId,
    outcome: "ok",
    argsRedactedJson: JSON.stringify(out),
  });
  return out;
}

/**
 * Handle session.context_new control operation.
 * Starts a new context segment for the target session.
 */
export async function handleSessionContextNew(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  return handleSessionContextSegmentOp(
    {
      opName: "session_context_new",
      auditAction: "session.context_segment_new",
      killReason: "subagent_wait_timeout",
      apply: applySessionContextSegmentNew,
    },
    req,
    principal,
    ctx,
  );
}

/**
 * Handle session.context_reset control operation.
 * Resets the context segment of the target session.
 */
export async function handleSessionContextReset(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  return handleSessionContextSegmentOp(
    {
      opName: "session_context_reset",
      auditAction: "session.context_segment_reset",
      killReason: "context_segment_reset",
      apply: applySessionContextSegmentReset,
    },
    req,
    principal,
    ctx,
  );
}

/**
 * Handle session.compact control operation.
 * Compacts the target session's transcript.
 */
export async function handleSessionCompact(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "session_compact requires operator principal");
  }
  if (!ctx.stateDb) {
    throw new IntegrationOpError(
      "ERR_STATE_DB_REQUIRED",
      "session_compact requires state database",
    );
  }
  const pl = payloadObject(req);
  const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);

  // An active turn owns the transcript: park the compaction on its gate for
  // the loop's next break; a gate rejection falls through to the queued path.
  // No active turn: queued system turn, or inline when the queue is absent.
  let result: Awaited<ReturnType<typeof compactSessionTranscript>>;
  let deferred = false;
  const parked = pushCompactionRequest(sessionId);
  if (parked) {
    deferred = true;
    result = await parked.catch((e: unknown) => {
      if (e instanceof CompactionGateClosedError) {
        deferred = false;
        return runCompactionBehindQueue(ctx, sessionId);
      }
      throw e;
    });
  } else {
    result = await runCompactionBehindQueue(ctx, sessionId);
  }
  ctx.recordIntegrationAudit({
    action: "session.compact",
    resource: sessionId,
    outcome: "ok",
    argsRedactedJson: JSON.stringify({ ...result, deferred }),
  });
  return result;
}
