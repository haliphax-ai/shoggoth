import { daemonNotice } from "./notices";
import type { HitlRiskTier } from "@shoggoth/shared";

/**
 * Minimal subset of the pending-action row used by notice formatting.
 * Defined locally so this module stays platform-agnostic (no dependency on
 * platform-discord's daemon-types).
 */
export interface HitlPendingActionRow {
  readonly id: string;
  readonly sessionId: string;
  readonly correlationId: string | undefined;
  readonly toolName: string;
  readonly payload: unknown;
  readonly riskTier: HitlRiskTier;
}

/** Max chars for tool payload JSON shown in HITL notices. */
export const HITL_NOTICE_PAYLOAD_MAX_CHARS = 600;

/** JSON/string excerpt for operator-facing HITL copy; collapses whitespace, strips backticks. */
export function formatHitlPayloadExcerpt(
  payload: unknown,
  maxChars: number = HITL_NOTICE_PAYLOAD_MAX_CHARS,
): string | undefined {
  if (payload === undefined || payload === null) return undefined;
  let s: string;
  try {
    s = typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    s = String(payload);
  }
  const oneLine = s.replace(/`/g, "'").replace(/\r?\n/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars - 1)}…`;
}

/** Platform-agnostic notice lines for a queued HITL action. */
export function buildHitlQueuedNoticeLines(row: HitlPendingActionRow): string[] {
  const correlationLine = row.correlationId ? `run: \`${row.correlationId}\`\n` : "";
  const payloadExcerpt = formatHitlPayloadExcerpt(row.payload);
  const payloadLine = payloadExcerpt ? `payload (truncated): \`${payloadExcerpt}\`\n` : "";
  const text = daemonNotice("hitl-queued-notice", {
    id: row.id,
    sessionId: row.sessionId,
    toolName: row.toolName,
    riskTier: row.riskTier,
    correlationLine,
    payloadLine,
  });
  return text.split("\n");
}
