import { ModelHttpError } from "./errors";
import { RETRYABLE_STATUSES } from "./resilience";

/**
 * Status codes that trigger failover to the next provider/model in the chain.
 *
 * This set is a **strict superset** of the resilience-layer `RETRYABLE_STATUSES`
 * (which controls same-provider retries). Failover adds `429` because rate limits
 * are per-provider — a different provider is unlikely to share the same quota.
 *
 * We do NOT treat every 5xx as failover-eligible. Status codes like 501 (Not
 * Implemented) or 507 (Insufficient Storage) indicate a capability or
 * infrastructure problem that is unlikely to resolve by switching providers.
 */
const FAILOVER_STATUSES = new Set([...RETRYABLE_STATUSES, 429]);

/**
 * Errors where trying the next provider/model in the failover chain may help.
 */
export function isFailoverEligibleError(err: unknown): boolean {
  if (err instanceof ModelHttpError) {
    return FAILOVER_STATUSES.has(err.status);
  }
  if (err instanceof TypeError) {
    const m = err.message.toLowerCase();
    if (m.includes("fetch")) return true;
  }
  return false;
}
