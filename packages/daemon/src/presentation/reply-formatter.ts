import type { ShoggothConfig } from "@shoggoth/shared";
import { formatAgentIdentityPrefix } from "@shoggoth/shared";
import { ModelHttpError } from "@shoggoth/models";
import { daemonNotice } from "./notices.js";

// ---------------------------------------------------------------------------
// Minimal local interface — avoids importing the full session-tool-loop types.
// ---------------------------------------------------------------------------

export interface FailoverMeta {
  readonly degraded: boolean;
  readonly usedModel: string;
  readonly usedProviderId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GENERIC_ERROR_MESSAGE_CAP = 360;

const FETCH_LIKE_TYPEERROR =
  /fetch|Failed to fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|NetworkError/i;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function extractHitlPendingId(s: string): string | undefined {
  const m = s.match(/hitl_pending:([^\s]+)/);
  return m?.[1];
}

function modelHttpErrorToUserMessage(err: ModelHttpError): string {
  switch (err.status) {
    case 429:
      return daemonNotice("error-model-429");
    case 502:
    case 503:
    case 504:
      return daemonNotice("error-model-502-504");
    case 500:
      return daemonNotice("error-model-500");
    case 401:
      return daemonNotice("error-model-401");
    case 400: {
      const detail = err.bodySnippet?.trim();
      const excerpt = detail ? truncate(detail, 420) : "";
      return excerpt.length > 0
        ? daemonNotice("error-model-400-with-detail", { detail: excerpt })
        : daemonNotice("error-model-400-generic");
    }
    default:
      return daemonNotice("error-model-default", { status: String(err.status) });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Degraded-model banner when failover was used. */
export function formatDegradedPrefix(meta: FailoverMeta | undefined): string {
  if (!meta?.degraded) return "";
  return `${daemonNotice("degraded-banner", { usedModel: meta.usedModel, usedProviderId: meta.usedProviderId })}\n\n`;
}

/**
 * Model-tag footer line.
 * Checks both `SHOGGOTH_MODEL_TAG` (platform-agnostic) and
 * `SHOGGOTH_DISCORD_MODEL_TAG` (legacy compat).
 */
export function formatModelTagFooter(
  processEnv: NodeJS.ProcessEnv | undefined,
  meta: FailoverMeta | undefined,
): string {
  const e = processEnv ?? process.env;
  if (e.SHOGGOTH_MODEL_TAG !== "1" && e.SHOGGOTH_DISCORD_MODEL_TAG !== "1") return "";
  if (!meta) return "";
  return `\n\n${daemonNotice("model-tag-footer", { usedModel: meta.usedModel, usedProviderId: meta.usedProviderId })}`;
}

/** Human-friendly error text for a caught exception. */
export function formatErrorUserText(e: unknown): string {
  if (e instanceof ModelHttpError) {
    return modelHttpErrorToUserMessage(e);
  }
  if (e instanceof TypeError) {
    const m = e.message ?? "";
    if (FETCH_LIKE_TYPEERROR.test(m)) {
      return daemonNotice("error-network-fetch");
    }
  }
  const raw = e instanceof Error ? e.message : String(e);
  const hitlId = extractHitlPendingId(raw);
  if (hitlId) {
    return daemonNotice("error-hitl-pending", { hitlId });
  }
  if (e instanceof Error) {
    const line = raw.split("\n")[0]?.trim() ?? raw;
    return truncate(line, GENERIC_ERROR_MESSAGE_CAP);
  }
  return truncate(String(e), GENERIC_ERROR_MESSAGE_CAP);
}

/**
 * Compose a full assistant reply:
 *   degraded prefix + agent identity prefix + assistant text + model tag footer
 */
export function formatAssistantReply(
  config: ShoggothConfig,
  sessionId: string,
  env: NodeJS.ProcessEnv | undefined,
  latestText: string,
  failoverMeta: FailoverMeta | undefined,
): string {
  const degraded = formatDegradedPrefix(failoverMeta);
  const identity = formatAgentIdentityPrefix(config, sessionId);
  const footer = formatModelTagFooter(env, failoverMeta);
  return `${degraded}${identity}${latestText}${footer}`;
}
