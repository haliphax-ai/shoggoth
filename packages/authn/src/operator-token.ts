/**
 * Optional operator token — constant-time compare via SHA-256.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Hash the raw operator token (SHA-256).
 *
 * Intentionally not a shared `hashToken` utility with agent-token: the two
 * domains stay decoupled, and the "duplication" is a single SHA-256 expression.
 * Change both together if the hashing scheme ever changes.
 */
export function hashOperatorTokenOpaque(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Compare presented token to configured secret using SHA-256 + timingSafeEqual.
 */
export function validateOperatorToken(configuredSecret: string, presentedToken: string): boolean {
  const a = hashOperatorTokenOpaque(configuredSecret);
  const b = hashOperatorTokenOpaque(presentedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
