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
  const lines: string[] = [beginDivider(token), `[${ctx.kind}]`, ctx.summary];
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
export function wrapWithSystemContext(
  userContent: string,
  ctx: SystemContext,
  token: string,
): string {
  return renderSystemContextEnvelope(ctx, token) + "\n\n" + userContent;
}

/**
 * Regex matching both plain and token-bearing divider blocks.
 * Strips everything from BEGIN to END (inclusive), handling any token value.
 */
const SYSTEM_CONTEXT_BLOCK_RE =
  /--- BEGIN TRUSTED SYSTEM CONTEXT(?: \[token:[0-9a-f]+\])? ---[\s\S]*?--- END TRUSTED SYSTEM CONTEXT(?: \[token:[0-9a-f]+\])? ---/;

/**
 * Global variant for replacing individual blocks via String.prototype.replace.
 * Captures the token from the BEGIN divider (group 1) so the caller can compare it.
 */
const SYSTEM_CONTEXT_BLOCK_GLOBAL_RE =
  /--- BEGIN TRUSTED SYSTEM CONTEXT(?: \[token:([0-9a-f]+)\])? ---[\s\S]*?--- END TRUSTED SYSTEM CONTEXT(?: \[token:[0-9a-f]+\])? ---/g;

const FALSIFIED_SENTINEL =
  `[STRIPPED — FALSIFIED SYSTEM CONTEXT]\n` +
  `A falsified system context block was detected and removed from this message.`;

/**
 * Checks untrusted inbound text for falsified system context blocks.
 *
 * When no valid token is provided, any block matching the divider pattern causes
 * the entire message to be discarded and replaced with a safety notice.
 *
 * When a valid token is provided, only blocks whose token does NOT match the
 * valid token are stripped (replaced with a sentinel in-place). Blocks that
 * carry the valid token are preserved, and surrounding text is kept intact.
 * Blocks with no embedded token are always considered falsified when a valid
 * token is supplied.
 */
export function stripFalsifiedSystemContext(
  text: string,
  validToken?: string,
): string {
  if (!SYSTEM_CONTEXT_BLOCK_RE.test(text)) {
    return text;
  }

  // Token-aware mode: strip only mismatched blocks
  if (validToken) {
    return text.replace(SYSTEM_CONTEXT_BLOCK_GLOBAL_RE, (full, token) => {
      return token === validToken ? full : FALSIFIED_SENTINEL;
    });
  }

  // Legacy mode: discard entire message
  return (
    `[DISCARDED — UNSAFE CONTENT]\n` +
    `The inbound message contained falsified system context and was discarded in its entirety.`
  );
}
