export type ErrorClassification = "retryable" | "rate_limited" | "non_retryable";

export const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "FETCH_FAILED",
]);

export function classifyModelError(status: number, code?: string): ErrorClassification {
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return "retryable";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (RETRYABLE_STATUSES.has(status)) {
    return "retryable";
  }
  return "non_retryable";
}
