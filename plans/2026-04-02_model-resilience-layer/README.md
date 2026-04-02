# Model Resilience Layer — Implementation Plan

## Problem

Model API calls (`model.complete()`) can fail with transient errors — rate limits (429), gateway timeouts (502/503/504), connection resets — and currently these propagate straight up through the tool loop, killing the entire agent turn. There's no retry, no backoff, and no coordination across concurrent sessions hitting the same provider.

Multiple workflow tasks running in parallel can easily saturate a provider's rate limit, causing cascading failures across all active sessions.

## Goal

A global singleton that sits between the model client layer and the HTTP transport, providing:

1. **Proactive rate limiting** — track usage per provider, throttle requests before hitting limits
2. **Retry with backoff** — automatically retry recoverable errors with exponential backoff + jitter
3. **Provider isolation** — separate managers per provider so a rate-limited Anthropic doesn't block Gemini calls
4. **Coordinated concurrency** — all sessions share the same manager, so parallel workflow tasks don't blindly race into rate limits
5. **Graceful degradation** — after exhausting retries, surface a clear error to the turn (not a raw HTTP exception)

## Architecture

```
tool-loop → model-client → failover-client → resilience-layer → HTTP transport
                                                ↑
                                          global singleton
                                          per-provider managers
```

### Singleton: `ModelResilienceGate`

```ts
interface ModelResilienceGate {
  /** Acquire permission to make a request to this provider. Resolves when safe to proceed. */
  acquire(providerId: string): Promise<void>;

  /** Report a successful response (resets failure counters, updates rate tracking). */
  reportSuccess(providerId: string, headers?: ResponseHeaders): void;

  /** Report a failed response. Returns retry guidance. */
  reportFailure(providerId: string, error: ModelHttpError): RetryGuidance;

  /** Execute a request with automatic retry/backoff. */
  executeWithResilience<T>(
    providerId: string,
    fn: () => Promise<T>,
    opts?: ResilienceOptions,
  ): Promise<T>;

  /** Get current state for a provider (for diagnostics / /status). */
  getProviderState(providerId: string): ProviderState;
}
```

### Per-Provider Manager: `ProviderResilienceManager`

Each configured provider instance gets its own manager, keyed by the provider's config ID (e.g. `"anthropic-prod"`, `"openai-fast"`, `"openai-bulk"`). Users may configure multiple instances of the same provider kind (e.g. two OpenAI endpoints with different API keys and rate limits), so managers are per-config-entry, not per-provider-type.

```ts
interface ProviderResilienceManager {
  /** Semaphore / token bucket for concurrency control. */
  readonly concurrencyGate: ConcurrencyGate;

  /** Sliding window rate tracker. */
  readonly rateTracker: RateTracker;

  /** Backoff state (current delay, failure count, cooldown-until timestamp). */
  readonly backoff: BackoffState;
}
```

### Retry Classification

Not all errors are retryable. Classification:

| HTTP Status | Classification | Action |
|---|---|---|
| 429 | Rate limited | Backoff using `Retry-After` header if present, else exponential |
| 500 | Server error | Retry with backoff (may be transient) |
| 502 | Gateway error | Retry with backoff |
| 503 | Service unavailable | Retry with backoff, respect `Retry-After` |
| 504 | Gateway timeout | Retry with backoff |
| 408 | Request timeout | Retry with backoff |
| Connection reset / ECONNRESET | Network error | Retry with backoff |
| 400 | Bad request | NOT retryable (client error) |
| 401 | Auth error | NOT retryable |
| 403 | Forbidden | NOT retryable |
| 404 | Not found | NOT retryable |
| 422 | Validation error | NOT retryable |

```ts
type ErrorClassification = "retryable" | "rate_limited" | "non_retryable";

function classifyModelError(error: ModelHttpError): ErrorClassification;
```

### Backoff Strategy

Exponential backoff with jitter, capped:

```
delay = min(maxDelay, baseDelay * 2^attempt) + random(0, jitter)
```

Defaults:
- `baseDelay`: 1000ms
- `maxDelay`: 60000ms (1 minute)
- `jitter`: 500ms
- `maxRetries`: 3

For 429 with `Retry-After` header: use the header value as the delay floor (skip exponential calculation if header delay is longer).

### Rate Tracking

Sliding window counter per provider:

- Track request timestamps in a rolling window (e.g. 60s)
- When the window is near capacity, `acquire()` delays the caller until the window slides
- Capacity is learned from provider response headers (`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`) when available
- Falls back to conservative defaults when headers aren't present

### Concurrency Control

Per-provider semaphore limiting concurrent in-flight requests:

- Default: 5 concurrent requests per provider
- Configurable per provider
- When all slots are occupied, `acquire()` queues the caller
- Prevents thundering herd when multiple workflow tasks start simultaneously

### Provider-Specific Header Parsing

Different providers use different rate limit headers:

**Anthropic:**
- `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`
- `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`
- `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`
- `retry-after`

**OpenAI:**
- `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`
- `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`
- `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`
- `retry-after`

**Google/Gemini:**
- `retry-after`
- `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`

```ts
interface ParsedRateLimitHeaders {
  requestLimit?: number;
  requestsRemaining?: number;
  requestResetMs?: number;
  tokenLimit?: number;
  tokensRemaining?: number;
  tokenResetMs?: number;
  retryAfterMs?: number;
}

function parseRateLimitHeaders(providerId: string, headers: Headers): ParsedRateLimitHeaders;
```

## Config

Global and per-provider overrides:

```json
{
  "runtime": {
    "modelResilience": {
      "maxRetries": 3,
      "baseDelayMs": 1000,
      "maxDelayMs": 60000,
      "jitterMs": 500,
      "defaultConcurrency": 5,
      "providers": {
        "anthropic-prod": {
          "maxRetries": 4,
          "concurrency": 3
        },
        "openai-fast": {
          "concurrency": 8
        },
        "openai-bulk": {
          "concurrency": 2,
          "maxRetries": 5
        }
      }
    }
  }
}
```

## Integration Points

### Where it hooks in

The resilience layer wraps the HTTP call inside the model provider's `completeWithTools` / `complete` method. Two options:

**Option A: Wrap at the HTTP transport level**
- Modify each provider's HTTP call to go through `executeWithResilience`
- Minimal changes to model client / failover client
- Provider ID is known at this level

**Option B: Wrap at the failover client level**
- The failover client already handles provider selection
- Add resilience wrapping around each provider attempt
- Natural place since failover already deals with provider failures

Recommendation: **Option A** — each provider's transport layer calls `executeWithResilience` around its HTTP fetch. This keeps the resilience logic close to the wire and gives access to response headers for rate limit tracking.

### What changes

- `@shoggoth/models` — each provider's HTTP call wraps through the resilience gate
- `packages/daemon/src/index.ts` — initialize the singleton at startup
- Config schema — add `runtime.modelResilience` section
- `/status` — optionally surface provider health state (current backoff, remaining quota)

### What doesn't change

- Tool loop — no changes needed; model.complete() either succeeds (after retries) or throws a non-retryable error
- Failover client — still handles provider failover; resilience handles transient errors within a single provider
- Session agent turn — no changes

## Files

1. **NEW** `packages/models/src/resilience/gate.ts` — `ModelResilienceGate` singleton
2. **NEW** `packages/models/src/resilience/provider-manager.ts` — per-provider state (backoff, rate tracking, concurrency)
3. **NEW** `packages/models/src/resilience/classify.ts` — error classification
4. **NEW** `packages/models/src/resilience/headers.ts` — provider-specific rate limit header parsing
5. **NEW** `packages/models/src/resilience/backoff.ts` — exponential backoff + jitter
6. **NEW** `packages/models/src/resilience/index.ts` — exports
7. `packages/models/src/providers/anthropic.ts` — wrap HTTP calls
8. `packages/models/src/providers/openai-compatible.ts` — wrap HTTP calls
9. `packages/models/src/providers/gemini.ts` — wrap HTTP calls
10. `packages/daemon/src/index.ts` — initialize singleton
11. Config schema update for `runtime.modelResilience`
12. Tests for classification, backoff, header parsing, retry logic

## Edge Cases

- **Concurrent retries across sessions:** The concurrency gate prevents all sessions from retrying simultaneously. When one session gets a 429, the backoff state is shared — other sessions see the cooldown and wait.
- **Provider failover + resilience:** If provider A exhausts retries, the failover client can still switch to provider B. Resilience is per-provider, failover is cross-provider.
- **Long backoff during tool loop:** If the model is in a long backoff (e.g. 60s), the tool loop's abort signal should still be respected. `executeWithResilience` should accept an `AbortSignal`.
- **Token-based rate limits:** Some providers limit tokens/minute separately from requests/minute. The rate tracker should support both dimensions when headers provide the data.
- **Cold start:** No rate limit data on first request. Use conservative defaults until headers are observed.
- **Config hot reload:** If `modelResilience` config changes, the singleton should pick up new values on next request (use configRef pattern).
