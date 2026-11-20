import { ModelHttpError } from "./errors";
import { RETRYABLE_STATUSES } from "./resilience";

/**
 * Status codes that trigger failover to the next provider/model in the chain.
 * A strict superset of the resilience-layer `RETRYABLE_STATUSES`; failover
 * additionally treats 429 as eligible (see docs/models.md, "Failover-Eligible
 * Errors").
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
