export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  maxRetries: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitterMs: 500,
  maxRetries: 3,
};

export function computeBackoffDelay(
  attempt: number,
  config: BackoffConfig,
  retryAfterMs?: number,
): number {
  const exponential = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);
  const jitter = Math.random() * config.jitterMs;
  const delay = exponential + jitter;
  if (retryAfterMs !== undefined && retryAfterMs > delay) {
    return retryAfterMs;
  }
  return delay;
}

export class BackoffState {
  private attempt = 0;
  private lastFailureTime: number | null = null;
  private cooldownUntil: number | null = null;
  private lastDelay = 0;

  constructor(private readonly config: BackoffConfig = DEFAULT_BACKOFF_CONFIG) {}

  recordFailure(retryAfterMs?: number): number {
    this.lastFailureTime = Date.now();
    const delay = computeBackoffDelay(this.attempt, this.config, retryAfterMs);
    this.cooldownUntil = this.lastFailureTime + delay;
    this.lastDelay = delay;
    this.attempt++;
    return delay;
  }

  recordSuccess(): void {
    this.attempt = 0;
    this.lastFailureTime = null;
    this.cooldownUntil = null;
    this.lastDelay = 0;
  }

  shouldRetry(): boolean {
    return this.attempt < this.config.maxRetries;
  }

  getDelay(): number {
    return this.lastDelay;
  }

  getRemainingDelay(): number {
    if (this.cooldownUntil === null) return 0;
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  isInCooldown(): boolean {
    if (this.cooldownUntil === null) {
      return false;
    }
    return Date.now() < this.cooldownUntil;
  }

  getAttempt(): number {
    return this.attempt;
  }
}
