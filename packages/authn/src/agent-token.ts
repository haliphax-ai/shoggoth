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

/**
 * Hash the raw agent credential (SHA-256); the digest is the only persisted form.
 *
 * Intentionally not a shared `hashToken` utility with operator-token: the two
 * domains stay decoupled, and the "duplication" is a single SHA-256 expression.
 * Change both together if the hashing scheme ever changes.
 */
export function hashAgentToken(raw: string): Uint8Array {
  return createHash("sha256").update(raw, "utf8").digest();
}

export class AgentTokenHashLengthError extends Error {
  override name = "AgentTokenHashLengthError";
}

/**
 * Constant-time comparison of the computed SHA-256 digest against the stored
 * hash. Returns false on a content mismatch; throws AgentTokenHashLengthError
 * when the stored hash's length differs from a SHA-256 digest (32 bytes) — a
 * data-integrity bug, not a legitimate auth failure. Hashes are typed as
 * Uint8Array; Buffer is a Uint8Array subclass, so callers may still pass
 * Buffers.
 */
export function timingSafeEqualRawToHash(raw: string, storedHash: Uint8Array): boolean {
  const h = hashAgentToken(raw);
  if (h.length !== storedHash.length) {
    throw new AgentTokenHashLengthError(
      `stored agent token hash length ${storedHash.length} != computed SHA-256 length ${h.length}`,
    );
  }
  return timingSafeEqual(h, storedHash);
}

export type AgentTokenRecord = {
  sessionId: string;
  tokenHash: Uint8Array;
  revoked: boolean;
};

export interface AgentTokenStore {
  register(sessionId: string, rawToken: string): void;
  /** Mint a fresh credential, persist only its hash, and return the raw token. */
  mintAndRegister(sessionId: string): string;
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

  mintAndRegister(sessionId: string): string {
    const raw = mintAgentCredentialRaw();
    this.register(sessionId, raw);
    return raw;
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

export function agentPrincipalFromToken(sessionId: string, agentId?: string): AgentPrincipal {
  return {
    kind: "agent",
    sessionId,
    agentId,
    source: "agent",
  };
}
