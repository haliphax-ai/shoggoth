import { ModelHttpError } from "@shoggoth/models";

/** Discord message body limit; success and error replies are sliced to this length. */
export const DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS = 2000;

const GENERIC_ERROR_MESSAGE_CAP = 360;

const FETCH_LIKE_TYPEERROR =
  /fetch|Failed to fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|NetworkError/i;

/**
 * Maps thrown values to short, Discord-safe copy (no stacks). The caller should
 * still log full `String(e)` for operators.
 */
export function formatDiscordPlatformErrorUserText(e: unknown): string {
  if (e instanceof ModelHttpError) {
    return modelHttpErrorToDiscordMessage(e);
  }
  if (e instanceof TypeError) {
    const m = e.message ?? "";
    if (FETCH_LIKE_TYPEERROR.test(m)) {
      return "Network error reaching the model provider. Check connectivity and DNS, then try again.";
    }
  }

  const raw = e instanceof Error ? e.message : String(e);
  const hitlId = extractHitlPendingId(raw);
  if (hitlId) {
    return (
      "This action needs operator approval before it can run. " +
      `Pending id: \`${hitlId}\`. An operator can approve or deny it via the pending-actions flow.`
    );
  }

  if (e instanceof Error) {
    const line = raw.split("\n")[0]?.trim() ?? raw;
    return truncate(line, GENERIC_ERROR_MESSAGE_CAP);
  }

  return truncate(String(e), GENERIC_ERROR_MESSAGE_CAP);
}

export function sliceDiscordPlatformMessageBody(text: string): string {
  return text.slice(0, DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS);
}

function extractHitlPendingId(s: string): string | undefined {
  const m = s.match(/hitl_pending:([^\s]+)/);
  return m?.[1];
}

function modelHttpErrorToDiscordMessage(err: ModelHttpError): string {
  switch (err.status) {
    case 429:
      return "The model provider rate-limited this request. Wait a bit and try again.";
    case 502:
    case 503:
    case 504:
      return "The model provider is temporarily unavailable (upstream error). Try again shortly.";
    case 500:
      return "The model provider returned an internal error (HTTP 500). Try again later.";
    case 401:
      return "Model API authentication failed (HTTP 401). Check API keys and provider configuration.";
    case 400: {
      const detail = err.bodySnippet?.trim();
      const excerpt = detail ? truncate(detail, 420) : "";
      return excerpt.length > 0
        ? `Model request rejected (HTTP 400): ${excerpt}`
        : "Model request rejected (HTTP 400). Check model id, message shape, and tool schemas.";
    }
    default:
      return `Model request failed (HTTP ${err.status}). Try again or check provider status.`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
