import { DEFAULT_BACKOFF_CONFIG } from "./backoff.js";
import { classifyModelError } from "./classify.js";
import { ProviderResilienceManager, type ProviderResilienceConfig } from "./provider-manager.js";

export interface ResilienceOptions {
  abortSignal?: AbortSignal;
  providerKind?: string;
}

interface ResilienceGlobalDefaults {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  defaultConcurrency?: number;
}

export class ModelResilienceGate {
  private readonly managers = new Map<string, ProviderResilienceManager>();
  private readonly globalDefaults: ResilienceGlobalDefaults;
  private readonly providerOverrides: Record<string, ProviderResilienceConfig>;

  constructor(
    globalDefaults?: ResilienceGlobalDefaults,
    providerOverrides?: Record<string, ProviderResilienceConfig>,
  ) {
    this.globalDefaults = globalDefaults ?? {};
    this.providerOverrides = providerOverrides ?? {};
  }

  getOrCreateManager(providerId: string): ProviderResilienceManager {
    let manager = this.managers.get(providerId);
    if (manager) return manager;

    const overrides = this.providerOverrides[providerId];
    const config: ProviderResilienceConfig = {
      maxRetries: overrides?.maxRetries ?? this.globalDefaults.maxRetries,
      baseDelayMs: overrides?.baseDelayMs ?? this.globalDefaults.baseDelayMs,
      maxDelayMs: overrides?.maxDelayMs ?? this.globalDefaults.maxDelayMs,
      jitterMs: overrides?.jitterMs ?? this.globalDefaults.jitterMs,
      concurrency: overrides?.concurrency ?? this.globalDefaults.defaultConcurrency,
    };

    manager = new ProviderResilienceManager(providerId, config);
    this.managers.set(providerId, manager);
    return manager;
  }

  async executeWithResilience<T>(
    providerId: string,
    fn: () => Promise<T>,
    opts?: ResilienceOptions,
  ): Promise<T> {
    const manager = this.getOrCreateManager(providerId);
    const overrides = this.providerOverrides[providerId];
    const maxRetries =
      overrides?.maxRetries ??
      this.globalDefaults.maxRetries ??
      DEFAULT_BACKOFF_CONFIG.maxRetries;

    let attempt = 0;

    while (true) {
      await manager.acquireSlot();
      let slotReleased = false;
      try {
        const result = await fn();
        manager.recordSuccess();
        return result;
      } catch (err: unknown) {
        const { status, code } = extractErrorInfo(err);
        const classification = classifyModelError(status, code);

        if (
          (classification === "retryable" || classification === "rate_limited") &&
          attempt < maxRetries
        ) {
          const retryAfterMs = classification === "rate_limited" ? extractRetryAfter(err) : undefined;
          const delay = manager.recordFailure(retryAfterMs);
          manager.release();
          slotReleased = true;
          attempt++;
          await abortableDelay(delay, opts?.abortSignal);
          continue;
        }

        throw err;
      } finally {
        if (!slotReleased) {
          manager.release();
        }
      }
    }
  }

  getProviderState(providerId: string): {
    inFlight: number;
    requestsInWindow: number;
    isInCooldown: boolean;
    backoffAttempt: number;
  } {
    const manager = this.managers.get(providerId);
    if (!manager) {
      return { inFlight: 0, requestsInWindow: 0, isInCooldown: false, backoffAttempt: 0 };
    }
    return {
      inFlight: manager.getInFlight(),
      requestsInWindow: manager.getRequestsInWindow(),
      isInCooldown: manager.isInCooldown(),
      backoffAttempt: manager.getBackoffAttempt(),
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let singletonGate: ModelResilienceGate | undefined;

export function setResilienceGate(gate: ModelResilienceGate): void {
  singletonGate = gate;
}

export function getResilienceGate(): ModelResilienceGate {
  if (!singletonGate) {
    singletonGate = new ModelResilienceGate();
  }
  return singletonGate;
}

// ── Helpers ────────────────────────────────────────────────────────

function extractErrorInfo(err: unknown): { status: number; code?: string } {
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const status =
      (typeof obj.status === "number" ? obj.status : undefined) ??
      (typeof obj.statusCode === "number" ? obj.statusCode : undefined) ??
      0;
    const code = typeof obj.code === "string" ? obj.code : undefined;
    return { status, code };
  }
  return { status: 0 };
}

function extractRetryAfter(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.retryAfterMs === "number") return obj.retryAfterMs;
    if (typeof obj.retryAfter === "number") return obj.retryAfter * 1000;
  }
  return undefined;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
