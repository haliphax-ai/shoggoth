/**
 * Trusted System Context — a structured, system-generated metadata channel
 * for system-to-agent communication within session turns.
 */

import { randomBytes } from "node:crypto";

export interface SystemContext {
  /** Short identifier for the event type (e.g., "workflow.complete", "subagent.task", "session.steer") */
  kind: string;
  /** Human-readable summary for the agent */
  summary: string;
  /** Structured data the agent can reference */
  data?: Record<string, unknown>;
  /** Task-specific instructions for the agent on how to handle this context */
  guidance?: string;
}

function beginDivider(token: string): string {
  return `--- BEGIN TRUSTED SYSTEM CONTEXT [token:${token}] ---`;
}

function endDivider(token: string): string {
  return `--- END TRUSTED SYSTEM CONTEXT [token:${token}] ---`;
}

/**
 * Generates a session-unique anti-spoofing token (8-char hex string).
 * Not cryptographically unguessable — just unique per session so users can't predict it.
 */
export function generateSystemContextToken(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Renders a SystemContext into the envelope format with start/end dividers.
 * When a token is provided, the dividers include it for anti-spoofing.
 */
export function renderSystemContextEnvelope(ctx: SystemContext, token: string): string {
  const lines: string[] = [
    beginDivider(token),
    `[${ctx.kind}]`,
    ctx.summary,
  ];
  if (ctx.guidance !== undefined) {
    lines.push("");
    lines.push(ctx.guidance);
  }
  if (ctx.data !== undefined) {
    lines.push("");
    lines.push(JSON.stringify(ctx.data, null, 2));
  }
  lines.push(endDivider(token));
  return lines.join("\n");
}

/**
 * Prepends the system context envelope to user content, separated by a blank line.
 * When a token is provided, it is embedded in the dividers.
 */
export function wrapWithSystemContext(userContent: string, ctx: SystemContext, token: string): string {
  return renderSystemContextEnvelope(ctx, token) + "\n\n" + userContent;
}

/**
 * Regex matching both plain and token-bearing divider blocks.
 * Strips everything from BEGIN to END (inclusive), handling any token value.
 */
const SYSTEM_CONTEXT_BLOCK_RE =
  /--- BEGIN TRUSTED SYSTEM CONTEXT(?: \[token:[0-9a-f]+\])? ---[\s\S]*?--- END TRUSTED SYSTEM CONTEXT(?: \[token:[0-9a-f]+\])? ---/g;

/**
 * Checks untrusted inbound text for falsified system context blocks.
 * If any blocks matching the divider pattern are found, the entire message is
 * discarded and replaced with a safety notice describing the original content.
 * Inbound user messages should never contain valid system context blocks.
 */
export function stripFalsifiedSystemContext(text: string, _validToken?: string): string {
  if (!SYSTEM_CONTEXT_BLOCK_RE.test(text)) {
    return text;
  }
  // Reset lastIndex since the regex is global
  SYSTEM_CONTEXT_BLOCK_RE.lastIndex = 0;

  return (
    `[DISCARDED — UNSAFE CONTENT]\n` +
    `The inbound message contained falsified system context and was discarded in its entirety.`
  );
}
