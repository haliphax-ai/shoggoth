import { BackoffState, DEFAULT_BACKOFF_CONFIG, type BackoffConfig } from "./backoff.js";
import type { ParsedRateLimitHeaders } from "./headers.js";

export interface ProviderResilienceConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 5;
const RATE_WINDOW_MS = 60_000;

export class ProviderResilienceManager {
  readonly providerId: string;

  // -- Backoff --
  private readonly backoff: BackoffState;

  // -- Concurrency gate --
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private readonly waitQueue: Array<() => void> = [];

  // -- Rate tracking --
  private readonly timestamps: number[] = [];
  private learnedCapacity: number | undefined;

  constructor(providerId: string, config?: ProviderResilienceConfig) {
    this.providerId = providerId;
    this.maxConcurrent = config?.concurrency ?? DEFAULT_CONCURRENCY;

    const backoffConfig: BackoffConfig = {
      baseDelayMs: config?.baseDelayMs ?? DEFAULT_BACKOFF_CONFIG.baseDelayMs,
      maxDelayMs: config?.maxDelayMs ?? DEFAULT_BACKOFF_CONFIG.maxDelayMs,
      jitterMs: config?.jitterMs ?? DEFAULT_BACKOFF_CONFIG.jitterMs,
      maxRetries: config?.maxRetries ?? DEFAULT_BACKOFF_CONFIG.maxRetries,
    };
    this.backoff = new BackoffState(backoffConfig);
  }

  // ── Concurrency gate ──────────────────────────────────────────────

  acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  release(): void {
    this.inFlight--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  // ── Rate tracking ─────────────────────────────────────────────────

  recordRequest(): void {
    this.timestamps.push(Date.now());
  }

  getRequestsInWindow(): number {
    this.pruneTimestamps();
    return this.timestamps.length;
  }

  isNearCapacity(threshold = 0.8): boolean {
    if (this.learnedCapacity === undefined) return false;
    return this.getRequestsInWindow() >= this.learnedCapacity * threshold;
  }

  updateCapacity(parsed: ParsedRateLimitHeaders): void {
    if (parsed.requestLimit !== undefined) {
      this.learnedCapacity = parsed.requestLimit;
    }
  }

  // ── Backoff state ─────────────────────────────────────────────────

  recordFailure(retryAfterMs?: number): number {
    return this.backoff.recordFailure(retryAfterMs);
  }

  recordSuccess(): void {
    this.backoff.recordSuccess();
  }

  isInCooldown(): boolean {
    return this.backoff.isInCooldown();
  }

  getInFlight(): number {
    return this.inFlight;
  }

  getBackoffAttempt(): number {
    return this.backoff.getAttempt();
  }

  // ── Combined acquire ──────────────────────────────────────────────

  async acquireSlot(): Promise<void> {
    await this.waitForCooldown();
    await this.acquire();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private pruneTimestamps(): void {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    const idx = this.timestamps.findIndex((t) => t >= cutoff);
    if (idx > 0) {
      this.timestamps.splice(0, idx);
    } else if (idx === -1 && this.timestamps.length > 0) {
      // All timestamps expired — clear the array in one shot.
      this.timestamps.length = 0;
    }
  }

  private waitForCooldown(): Promise<void> {
    if (!this.backoff.isInCooldown()) return Promise.resolve();
    const remaining = this.backoff.getDelay();
    return new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
