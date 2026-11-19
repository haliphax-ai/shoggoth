/**
 * Control plane canned prompt operations (run and list).
 */

import { readFileSync } from "node:fs";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type { IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";
import { listPromptFiles, PromptOpError, renderPrompt, resolvePromptFile } from "./prompt-ops";
import {
  assertAgentMayTargetSessionForSendOrList,
  resolveSessionSendTargetSessionId,
} from "./ops-shared";
import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { getLogger } from "../logging";

const ioLog = getLogger("prompt-ops");

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

function optionalRecordObject(
  pl: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = pl[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

function optionalBooleanFlag(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be a boolean`);
  }
  return v;
}

function requireSubagentRuntime(ctx: IntegrationOpsContext): {
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

/**
 * Handle prompt control operation.
 */
export async function handlePrompt(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  ioLog.debug("canned prompt", { op: req.op, principalKind: principal.kind });
  if (principal.kind !== "operator" && principal.kind !== "agent") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "prompt requires operator or agent principal");
  }
  const ext = subagentRuntimeExtensionRef.current;
  if (!ext) {
    throw new IntegrationOpError(
      "ERR_SUBAGENT_RUNTIME_UNAVAILABLE",
      "prompt requires messaging runtime",
    );
  }
  const { sessions } = requireSubagentRuntime(ctx);
  const pl = payloadObject(req);
  const slug = requireString(pl, "slug");
  const sessionId = resolveSessionSendTargetSessionId(pl, ctx.config, ctx.sessions);
  assertAgentMayTargetSessionForSendOrList(principal, sessionId, ctx.config);
  const paramsRaw = optionalRecordObject(pl, "params") ?? {};
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(paramsRaw)) {
    if (typeof v !== "string") {
      throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.params.${k} must be a string`);
    }
    params[k] = v;
  }
  const row = sessions.getById(sessionId);
  if (!row || row.status === "terminated") {
    throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
  }
  if (row.subagentMode === "one_shot") {
    throw new IntegrationOpError(
      "ERR_SUBAGENT_ONE_SHOT",
      "one_shot subagents cannot receive prompt",
    );
  }
  let message: string;
  try {
    const promptPath = resolvePromptFile(row.workspacePath, ctx.config.prompts?.globalDir, slug);
    if (!promptPath) {
      throw new PromptOpError("ERR_PROMPT_NOT_FOUND", `prompt not found: ${slug}`);
    }
    message = renderPrompt(readFileSync(promptPath, "utf8"), params);
  } catch (e) {
    if (e instanceof PromptOpError) {
      throw new IntegrationOpError(e.code, e.message);
    }
    throw e;
  }
  const silent = pl.silent === true;
  const platformUserIdRaw = pl.platform_user_id;
  const platformUserId =
    typeof platformUserIdRaw === "string" && platformUserIdRaw.trim()
      ? platformUserIdRaw.trim()
      : undefined;
  const replyToMessageId =
    typeof pl.reply_to_message_id === "string" && pl.reply_to_message_id.trim()
      ? pl.reply_to_message_id.trim()
      : undefined;
  const delivery = silent
    ? ({ kind: "internal" } as const)
    : (() => {
        if (!platformUserId && !row.subagentPlatformThreadId?.trim()) {
          throw new IntegrationOpError(
            "ERR_MISSING_PLATFORM_USER_ID",
            "platform_user_id is required for messaging_surface delivery",
          );
        }
        return {
          kind: "messaging_surface",
          userId: platformUserId ?? "system",
          replyToMessageId,
        } as const;
      })();
  const senderSessionId =
    principal.kind === "agent" ? principal.sessionId : `operator:${principal.operatorId}`;
  const turnInput: Parameters<typeof ext.runSessionModelTurn>[0] = {
    sessionId,
    userContent: message,
    userMetadata: { prompt: slug },
    systemContext: {
      kind: "session.message",
      summary: `Canned prompt "${slug}" from session ${senderSessionId}.`,
      data: { sender_session_id: senderSessionId, prompt_slug: slug },
    },
    delivery,
  };
  if (optionalBooleanFlag(pl, "wait") === false) {
    // wait:false — the prompt is delivered; return without waiting for
    // the turn. Callers report an immediate "submitted" status and the
    // turn's outcome reaches the operator via the delivery surface.
    void ext.runSessionModelTurn(turnInput).catch((err) => {
      ioLog.warn("canned prompt detached turn failed", {
        sessionId,
        slug,
        err: String(err),
      });
    });
    ctx.recordIntegrationAudit({
      action: "prompt.run",
      resource: sessionId,
      outcome: "delivered",
      argsRedactedJson: JSON.stringify({ slug, wait: false }),
    });
    return { delivered: true, session_id: sessionId, slug };
  }
  const turn = await ext.runSessionModelTurn(turnInput);
  ctx.recordIntegrationAudit({
    action: "prompt.run",
    resource: sessionId,
    outcome: "ok",
    argsRedactedJson: JSON.stringify({ slug }),
  });
  return {
    reply: turn.latestAssistantText,
    failover: turn.failoverMeta ?? null,
  };
}

/**
 * Handle prompt_list control operation.
 */
export async function handlePromptList(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator" && principal.kind !== "agent") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "prompt_list requires operator or agent principal",
    );
  }
  const pl = payloadObject(req);
  let workspaceDir: string | undefined;
  const hasTarget =
    (typeof pl.session_id === "string" && pl.session_id.trim()) ||
    (typeof pl.agent_id === "string" && pl.agent_id.trim());
  if (hasTarget) {
    const { sessions } = requireSubagentRuntime(ctx);
    const sessionId = resolveSessionSendTargetSessionId(pl, ctx.config, ctx.sessions);
    assertAgentMayTargetSessionForSendOrList(principal, sessionId, ctx.config);
    const row = sessions.getById(sessionId);
    workspaceDir = row?.workspacePath;
  } else if (principal.kind === "agent") {
    const { sessions } = requireSubagentRuntime(ctx);
    const row = sessions.getById(principal.sessionId);
    workspaceDir = row?.workspacePath;
  }
  return { prompts: listPromptFiles(workspaceDir, ctx.config.prompts?.globalDir) };
}
