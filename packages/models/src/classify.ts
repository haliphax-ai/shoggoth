import { ModelHttpError } from "./errors";

/**
 * Errors where trying the next provider/model in the failover chain may help.
 */
export function isFailoverEligibleError(err: unknown): boolean {
  if (err instanceof ModelHttpError) {
    const s = err.status;
    // 429: rate limits. Any 5xx from upstream HTTP (incl. proxies e.g. 520–524): try next hop.
    if (s === 429 || (s >= 500 && s < 600)) return true;
    return false;
  }
  if (err instanceof TypeError) {
    const m = err.message.toLowerCase();
    if (m.includes("fetch")) return true;
  }
  return false;
}
