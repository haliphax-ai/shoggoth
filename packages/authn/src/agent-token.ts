/**
 * Session-scoped agent credentials.
 * Persist hash in the database; raw token only in agent runtime.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentPrincipal } from "./principal";

const RAW_BYTES = 32;

/** Environment variable name for the raw session agent credential (inject at spawn only). */
export const SHOGGOTH_AGENT_TOKEN_ENV = "SHOGGOTH_AGENT_TOKEN" as const;

export function mintAgentCredentialRaw(): string {
  return randomBytes(RAW_BYTES).toString("base64url");
}

export function hashAgentToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

export function timingSafeEqualRawToHash(raw: string, storedHash: Buffer): boolean {
  const h = hashAgentToken(raw);
  if (h.length !== storedHash.length) return false;
  return timingSafeEqual(h, storedHash);
}

export type AgentTokenRecord = {
  sessionId: string;
  tokenHash: Buffer;
  revoked: boolean;
};

export interface AgentTokenStore {
  register(sessionId: string, rawToken: string): void;
  revoke(sessionId: string): void;
  validate(rawToken: string, sessionId: string): boolean;
}

export class MemoryAgentTokenStore implements AgentTokenStore {
  private bySession = new Map<string, AgentTokenRecord>();

  register(sessionId: string, rawToken: string): void {
    this.bySession.set(sessionId, {
      sessionId,
      tokenHash: hashAgentToken(rawToken),
      revoked: false,
    });
  }

  revoke(sessionId: string): void {
    const r = this.bySession.get(sessionId);
    if (r) r.revoked = true;
  }

  validate(rawToken: string, sessionId: string): boolean {
    const r = this.bySession.get(sessionId);
    if (!r || r.revoked) return false;
    return timingSafeEqualRawToHash(rawToken, r.tokenHash);
  }
}

export function agentPrincipalFromToken(
  sessionId: string,
  agentId?: string,
): AgentPrincipal {
  return {
    kind: "agent",
    sessionId,
    agentId,
    source: "agent",
  };
}
