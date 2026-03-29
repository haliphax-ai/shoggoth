/**
 * Optional operator token — constant-time compare via SHA-256.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function hashOperatorTokenOpaque(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Compare presented token to configured secret using SHA-256 + timingSafeEqual.
 */
export function validateOperatorToken(
  configuredSecret: string,
  presentedToken: string,
): boolean {
  const a = hashOperatorTokenOpaque(configuredSecret);
  const b = hashOperatorTokenOpaque(presentedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
