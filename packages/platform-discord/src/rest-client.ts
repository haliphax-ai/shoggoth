/**
 * Centralized, rate-limit-aware Discord REST client.
 *
 * Single point of contact for Discord REST traffic. Instead of firing every
 * request blind and eating 429s, the client meters proactively from Discord's
 * advertised headers (`X-RateLimit-Bucket`, `X-RateLimit-Remaining`,
 * `X-RateLimit-Reset-After`), schedules per bucket with priority lanes
 * (user-facing sends > workflow status > background probes), coalesces
 * same-message edits (latest-wins, one in-flight, stale = dropped), and folds
 * the entire 429/503 backoff into one mechanism with a whole-client pause for
 * `global: true` rate limits.
 *
 * Errors are typed (`RateLimitedError`, `NotFoundError`,
 * `MissingPermissionsError`, `ServerError`, `QueueTimeoutError`,
 * `NetworkError`) so callers can distinguish transient from permanent
 * failures instead of matching on error strings. All errors extend
 * `DiscordRestError` and keep the legacy `Discord REST <op> <status>: <body>`
 * message shape for log compatibility.
 */

/** Priority lanes: user-facing sends > workflow status > background probes. */
export type DiscordRestPriority = "user" | "status" | "background";

const PRIORITY_RANK: Record<DiscordRestPriority, number> = {
  user: 0,
  status: 1,
  background: 2,
};

/** Exported for tests and observability. */
export const discordRestRateLimitPolicy = {
  /** Total attempts (first try + retries) per request against retryable statuses. */
  maxAttempts: 6,
  /** Cap on cumulative backoff wait per request before rejecting. */
  maxTotalWaitMs: 90_000,
  /** Extra delay spread (ms) after Discord's suggested wait. */
  jitterMaxMs: 250,
  /** When Discord returns 429 but no `retry_after` / `Retry-After`, wait this many seconds. */
  default429DelaySec: 1,
  /**
   * A coalescable request (message edit) that has waited in queue longer than
   * this is rejected as stale — an edit delivered this late is worthless.
   */
  coalesceDeadlineMs: 10_000,
  /** Any request waiting in queue longer than this is rejected. */
  maxQueueWaitMs: 90_000,
} as const;

export type DiscordRestPolicy = Partial<typeof discordRestRateLimitPolicy>;

export type DiscordRestErrorKind =
  | "rate_limited"
  | "not_found"
  | "missing_permissions"
  | "server_error"
  | "queue_timeout"
  | "network"
  | "http";

/** Base class for every error thrown by the REST client. */
export class DiscordRestError extends Error {
  readonly kind: DiscordRestErrorKind;
  /** HTTP status when the error came from a response; null for network/queue errors. */
  readonly status: number | null;
  /** Response body (or empty string) when available. */
  readonly body: string;
  readonly operation: string;

  constructor(
    kind: DiscordRestErrorKind,
    operation: string,
    message: string,
    status: number | null = null,
    body = "",
  ) {
    super(message);
    this.name = "DiscordRestError";
    this.kind = kind;
    this.operation = operation;
    this.status = status;
    this.body = body;
  }
}

/** HTTP 429 — retries exhausted or backoff budget exceeded. */
export class RateLimitedError extends DiscordRestError {
  constructor(operation: string, status: number, body: string) {
    super("rate_limited", operation, `Discord REST ${operation} ${status}: ${body}`, status, body);
    this.name = "RateLimitedError";
  }
}

/** HTTP 404 — the target no longer exists. Safe for callers to repost/recreate. */
export class NotFoundError extends DiscordRestError {
  constructor(operation: string, status: number, body: string) {
    super("not_found", operation, `Discord REST ${operation} ${status}: ${body}`, status, body);
    this.name = "NotFoundError";
  }
}

/** HTTP 403 — missing permissions. Permanent until config changes. */
export class MissingPermissionsError extends DiscordRestError {
  constructor(operation: string, status: number, body: string) {
    super(
      "missing_permissions",
      operation,
      `Discord REST ${operation} ${status}: ${body}`,
      status,
      body,
    );
    this.name = "MissingPermissionsError";
  }
}

/** HTTP 5xx — server-side failure. Transient by nature. */
export class ServerError extends DiscordRestError {
  constructor(operation: string, status: number, body: string) {
    super("server_error", operation, `Discord REST ${operation} ${status}: ${body}`, status, body);
    this.name = "ServerError";
  }
}

/** The request waited in queue past its deadline without being dispatched. */
export class QueueTimeoutError extends DiscordRestError {
  constructor(operation: string, waitedMs: number, deadlineMs: number) {
    super(
      "queue_timeout",
      operation,
      `Discord REST ${operation}: queue wait deadline exceeded (${waitedMs}ms > ${deadlineMs}ms)`,
    );
    this.name = "QueueTimeoutError";
  }
}

/** The fetch itself failed (DNS, connection, aborted, …). */
export class NetworkError extends DiscordRestError {
  constructor(operation: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super("network", operation, `Discord REST ${operation} network error: ${msg}`);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

function classifyHttpError(operation: string, status: number, body: string): DiscordRestError {
  if (status === 404) return new NotFoundError(operation, status, body);
  if (status === 403) return new MissingPermissionsError(operation, status, body);
  if (status >= 500) return new ServerError(operation, status, body);
  return new DiscordRestError(
    "http",
    operation,
    `Discord REST ${operation} ${status}: ${body}`,
    status,
    body,
  );
}

export interface DiscordRestRequestSpec {
  /** Operation name for errors/logs, e.g. `createMessage`. */
  readonly operation: string;
  readonly method: string;
  /** Path including query string, relative to the API base. */
  readonly path: string;
  /**
   * Rate-limit route key. Method + path with major parameters (channel, guild,
   * webhook ids) kept and other dynamic segments normalized to `:id`, per
   * Discord's routing rules. Learning the `X-RateLimit-Bucket` hash for this
   * key meters every future request on the route.
   */
  readonly routeKey: string;
  readonly body?: BodyInit;
  readonly headers?: HeadersInit;
  /** Defaults per operation; overrides the operation's default lane. */
  readonly priority?: DiscordRestPriority;
  /**
   * Set for edit-style requests: at most one request per key is in flight and
   * at most one queued; a queued request superseded by a newer one is dropped
   * (its waiters settle with the newer request's outcome), and a queued
   * request older than `coalesceDeadlineMs` is rejected as stale.
   */
  readonly coalesceKey?: string;
}

export interface DiscordRestClientOptions {
  readonly botToken: string;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  readonly fetchFn?: typeof fetch;
  readonly apiBase?: string;
  /** Policy overrides (tests / tuning). */
  readonly policy?: DiscordRestPolicy;
}

interface BucketState {
  /** Advertised limit for the current window; null until learned. */
  limit: number | null;
  /** Requests left in the current window; null until learned (unknown). */
  remaining: number | null;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** Epoch ms until which this bucket is paused after a 429. */
  pausedUntil: number;
  /** Requests currently in flight (used to serialize unknown buckets). */
  inFlight: number;
  /** Dispatch queue sorted by (priority rank, sequence). */
  queue: QueuedRequest[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Epoch ms the current timer is set to fire (for re-arming earlier). */
  timerAt: number;
}

interface QueuedRequest {
  spec: DiscordRestRequestSpec;
  seq: number;
  enqueuedAt: number;
  attempts: number;
  totalWaitedMs: number;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
}

/** A queued edit waiting for its in-flight predecessor to finish. */
interface PendingCoalesce {
  spec: DiscordRestRequestSpec;
  enqueuedAt: number;
  waiters: Array<{ resolve: (res: Response) => void; reject: (err: unknown) => void }>;
}

export interface DiscordRestClient {
  /** Enqueue a request through the metered scheduler; resolves with the HTTP response. */
  request(spec: DiscordRestRequestSpec): Promise<Response>;
}

function numOrNull(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse a 429/503 body for `retry_after` (seconds) and the `global` flag. */
function parseRetryBody(text: string): { retryAfterSec: number | null; global: boolean } {
  try {
    const j = JSON.parse(text) as { retry_after?: unknown; global?: unknown };
    const retryAfterSec =
      typeof j.retry_after === "number" && Number.isFinite(j.retry_after)
        ? Math.max(0, j.retry_after)
        : null;
    return { retryAfterSec, global: j.global === true };
  } catch {
    return { retryAfterSec: null, global: false };
  }
}

function sortQueue(queue: QueuedRequest[]): void {
  queue.sort(
    (a, b) =>
      PRIORITY_RANK[a.spec.priority ?? "user"] - PRIORITY_RANK[b.spec.priority ?? "user"] ||
      a.seq - b.seq,
  );
}

/**
 * Create the process-wide Discord REST client. In the daemon a single instance
 * is shared by the whole messaging runtime (bridge → streaming, message tool,
 * HITL, slash commands), so every REST call flows through one meter.
 */
export function createDiscordRestClient(options: DiscordRestClientOptions): DiscordRestClient {
  const base = (options.apiBase ?? "https://discord.com/api/v10").replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const policy = { ...discordRestRateLimitPolicy, ...options.policy };

  /** routeKey → bucket hash learned from `X-RateLimit-Bucket`. */
  const routeToBucket = new Map<string, string>();
  /** Bucket hash (or provisional routeKey) → state. */
  const buckets = new Map<string, BucketState>();
  /** Coalesce keys with a request currently in flight. */
  const coalesceInFlight = new Set<string>();
  /** Coalesce keys with a queued (not yet dispatched) newest edit. */
  const coalescePending = new Map<string, PendingCoalesce>();
  /** Epoch ms until which every bucket is paused (global 429). */
  let globalPausedUntil = 0;
  let globalTimer: ReturnType<typeof setTimeout> | null = null;
  let globalTimerAt = 0;
  let seqCounter = 0;

  function getBucket(key: string): BucketState {
    let b = buckets.get(key);
    if (!b) {
      b = {
        limit: null,
        remaining: null,
        resetAt: 0,
        pausedUntil: 0,
        inFlight: 0,
        queue: [],
        timer: null,
        timerAt: 0,
      };
      buckets.set(key, b);
    }
    return b;
  }

  function unrefTimer(t: ReturnType<typeof setTimeout> | null): void {
    // Timers must never keep the daemon (or a test process) alive.
    (t as { unref?: () => void } | null)?.unref?.();
  }

  /** Arm a bucket wake-up, re-arming if the new target is earlier. */
  function armBucketTimer(key: string, state: BucketState, delayMs: number): void {
    const at = Date.now() + Math.max(0, delayMs);
    if (state.timer && state.timerAt <= at) return; // an earlier wake-up covers this
    if (state.timer) clearTimeout(state.timer);
    const t = setTimeout(
      () => {
        state.timer = null;
        state.timerAt = 0;
        schedule(key);
      },
      Math.max(0, at - Date.now()),
    );
    unrefTimer(t);
    state.timer = t;
    state.timerAt = at;
  }

  function armGlobalTimer(delayMs: number): void {
    const at = Date.now() + Math.max(0, delayMs);
    if (globalTimer && globalTimerAt <= at) return;
    if (globalTimer) clearTimeout(globalTimer);
    globalTimer = setTimeout(
      () => {
        globalTimer = null;
        globalTimerAt = 0;
        for (const key of buckets.keys()) schedule(key);
      },
      Math.max(0, at - Date.now()),
    );
    unrefTimer(globalTimer);
    globalTimerAt = at;
  }

  /** Resolve the bucket a request currently belongs to (re-checked after hash migration). */
  function resolveKey(spec: DiscordRestRequestSpec): string {
    return routeToBucket.get(spec.routeKey) ?? spec.routeKey;
  }

  /** Settle a request and release its coalesce slot, then reschedule. */
  function settle(entry: QueuedRequest, fn: () => void): void {
    // Re-resolve: the provisional bucket may have been migrated onto its
    // learned hash while this request was in flight.
    const key = resolveKey(entry.spec);
    const state = buckets.get(key);
    if (state) state.inFlight = Math.max(0, state.inFlight - 1);
    const ck = entry.spec.coalesceKey;
    if (ck) coalesceInFlight.delete(ck);
    fn();
    // Promote a pending coalesced edit, then keep dispatching.
    if (ck) promotePending(ck);
    schedule(key);
  }

  function promotePending(ck: string): void {
    if (coalesceInFlight.has(ck)) return;
    const pending = coalescePending.get(ck);
    if (!pending) return;
    coalescePending.delete(ck);
    const entry: QueuedRequest = {
      spec: pending.spec,
      seq: seqCounter++,
      enqueuedAt: pending.enqueuedAt,
      attempts: 0,
      totalWaitedMs: 0,
      resolve: (res) => {
        for (const w of pending.waiters) w.resolve(res);
      },
      reject: (err) => {
        for (const w of pending.waiters) w.reject(err);
      },
    };
    const state = getBucket(resolveKey(pending.spec));
    state.queue.push(entry);
    sortQueue(state.queue);
  }

  /** Deadline for a queued entry: coalesced edits expire far sooner. */
  function deadlineFor(q: QueuedRequest): number {
    return q.spec.coalesceKey ? policy.coalesceDeadlineMs : policy.maxQueueWaitMs;
  }

  /** Earliest queue deadline (epoch ms), or Infinity when the queue is empty. */
  function nextDeadline(key: string): number {
    const state = buckets.get(key);
    if (!state || state.queue.length === 0) return Infinity;
    let best = Infinity;
    for (const q of state.queue) best = Math.min(best, q.enqueuedAt + deadlineFor(q));
    return best;
  }

  /** Reject queue entries whose deadline has passed (even while paused). */
  function sweepDeadlines(key: string): void {
    const state = buckets.get(key);
    if (!state || state.queue.length === 0) return;
    const now = Date.now();
    const kept: QueuedRequest[] = [];
    for (const q of state.queue) {
      const dl = deadlineFor(q);
      if (now - q.enqueuedAt > dl)
        q.reject(new QueueTimeoutError(q.spec.operation, now - q.enqueuedAt, dl));
      else kept.push(q);
    }
    state.queue = kept;
  }

  /** Arm a wake-up for a blocked bucket at the earlier of block-end and queue deadline. */
  function armWhileBlocked(key: string, state: BucketState, blockUntil: number): void {
    const now = Date.now();
    armBucketTimer(key, state, Math.min(blockUntil, nextDeadline(key)) - now);
  }

  function schedule(key: string): void {
    const state = buckets.get(key);
    if (!state) return;

    // Expired deadlines are rejected promptly, even while the bucket is paused.
    sweepDeadlines(key);

    const now = Date.now();
    if (now < globalPausedUntil) {
      armGlobalTimer(globalPausedUntil - now);
      armWhileBlocked(key, state, globalPausedUntil);
      return;
    }
    if (now < state.pausedUntil) {
      armWhileBlocked(key, state, state.pausedUntil);
      return;
    }
    if (state.remaining !== null && state.remaining <= 0) {
      if (state.resetAt > now) {
        armWhileBlocked(key, state, state.resetAt);
        return;
      }
      // Window rolled over: restore whatever we know of the limit.
      state.remaining = state.limit;
      state.resetAt = 0;
    }

    while (state.queue.length > 0) {
      const head = state.queue[0]!;

      // One in-flight request per coalesce key: hold the newest edit back
      // until its predecessor lands.
      const ck = head.spec.coalesceKey;
      if (ck && coalesceInFlight.has(ck)) {
        state.queue.shift();
        const existing = coalescePending.get(ck);
        const pending: PendingCoalesce = {
          spec: head.spec,
          enqueuedAt: head.enqueuedAt,
          waiters: existing ? [...existing.waiters] : [],
        };
        pending.waiters.push({ resolve: head.resolve, reject: head.reject });
        coalescePending.set(ck, pending);
        continue;
      }

      // Unknown buckets serialize at one request until headers teach us the
      // limit; known buckets dispatch while capacity remains.
      if (state.remaining === null && state.inFlight > 0) return;
      if (state.remaining !== null && state.remaining <= 0) return;

      state.queue.shift();
      if (state.remaining !== null) state.remaining--;
      state.inFlight++;
      if (ck) coalesceInFlight.add(ck);
      dispatch(state, head);
    }
  }

  /** Apply `X-RateLimit-*` headers; returns the advertised bucket hash, if any. */
  function applyHeaders(state: BucketState, headers: Headers, now: number): string | null {
    const limit = numOrNull(headers.get("X-RateLimit-Limit"));
    const remaining = numOrNull(headers.get("X-RateLimit-Remaining"));
    const resetAfter = numOrNull(headers.get("X-RateLimit-Reset-After"));
    const reset = numOrNull(headers.get("X-RateLimit-Reset")); // epoch seconds
    if (limit != null) state.limit = limit;
    if (remaining != null) state.remaining = remaining;
    if (resetAfter != null) state.resetAt = now + resetAfter * 1000;
    else if (reset != null) state.resetAt = reset * 1000;
    return headers.get("X-RateLimit-Bucket");
  }

  /** Re-key a provisional (route-key) bucket onto its learned hash. */
  function migrateToHash(oldKey: string, hash: string): BucketState {
    const cur = buckets.get(oldKey);
    if (!cur || oldKey === hash) return getBucket(hash);
    const target = buckets.get(hash);
    if (!target) {
      buckets.set(hash, cur);
      buckets.delete(oldKey);
      return cur;
    }
    if (target !== cur) {
      // Merge: move queued work over and carry in-flight counts so settle()
      // decrements stay balanced after route-based re-resolution. The header
      // state just applied to `cur` is the freshest view of the shared
      // bucket, so it wins over the target's older numbers.
      target.inFlight += cur.inFlight;
      target.queue.push(...cur.queue);
      sortQueue(target.queue);
      cur.queue = [];
      if (cur.limit != null) target.limit = cur.limit;
      if (cur.remaining != null) target.remaining = cur.remaining;
      if (cur.resetAt > 0) target.resetAt = cur.resetAt;
      target.pausedUntil = Math.max(target.pausedUntil, cur.pausedUntil);
      buckets.delete(oldKey);
      armBucketTimer(hash, target, 0);
    }
    return target;
  }

  function dispatch(state: BucketState, entry: QueuedRequest): void {
    const headers = new Headers(entry.spec.headers ?? {});
    if (!headers.has("Authorization")) headers.set("Authorization", `Bot ${options.botToken}`);
    if (
      entry.spec.body != null &&
      !(entry.spec.body instanceof FormData) &&
      !headers.has("Content-Type")
    ) {
      headers.set("Content-Type", "application/json");
    }

    entry.attempts++;
    fetchFn(`${base}${entry.spec.path}`, {
      method: entry.spec.method,
      headers,
      body: entry.spec.body,
    }).then(
      (res) => {
        void onResponse(state, entry, res);
      },
      (err: unknown) => {
        settle(entry, () => entry.reject(new NetworkError(entry.spec.operation, err)));
      },
    );
  }

  async function onResponse(
    state: BucketState,
    entry: QueuedRequest,
    res: Response,
  ): Promise<void> {
    const op = entry.spec.operation;
    const now = Date.now();

    if (res.ok) {
      // Capture the provisional key BEFORE re-mapping the route, otherwise
      // migrateToHash would look up the new hash and skip the migration,
      // stranding the queue (and in-flight count) on the old bucket object.
      const oldKey = resolveKey(entry.spec);
      const hash = applyHeaders(state, res.headers, now);
      if (hash) {
        routeToBucket.set(entry.spec.routeKey, hash);
        migrateToHash(oldKey, hash);
      }
      settle(entry, () => entry.resolve(res));
      return;
    }

    const status = res.status;
    const bodyText = await res.text().catch(() => "");
    const retryAfterHeader = numOrNull(res.headers.get("Retry-After"));
    const retryable = status === 429 || (status === 503 && retryAfterHeader != null);

    if (!retryable) {
      settle(entry, () => entry.reject(classifyHttpError(op, status, bodyText)));
      return;
    }

    // Single backoff mechanism: pause the bucket (or the whole client for a
    // global 429) and requeue the request at the front of its lane.
    let delaySec: number | null = null;
    let global = false;
    if (status === 429) {
      const parsed = parseRetryBody(bodyText);
      delaySec =
        parsed.retryAfterSec ??
        (retryAfterHeader != null ? retryAfterHeader : policy.default429DelaySec);
      global = parsed.global;
    } else {
      delaySec = retryAfterHeader;
    }
    const jitter = policy.jitterMaxMs > 0 ? Math.floor(Math.random() * policy.jitterMaxMs) : 0;
    const waitMs = Math.ceil((delaySec ?? policy.default429DelaySec) * 1000) + jitter;

    const budgetExhausted =
      entry.attempts >= policy.maxAttempts || entry.totalWaitedMs + waitMs > policy.maxTotalWaitMs;
    if (budgetExhausted) {
      settle(entry, () => entry.reject(new RateLimitedError(op, status, bodyText)));
      return;
    }

    entry.totalWaitedMs += waitMs;
    if (global) {
      globalPausedUntil = Math.max(globalPausedUntil, Date.now() + waitMs);
    }

    settle(entry, () => {
      const key = resolveKey(entry.spec);
      const s = buckets.get(key);
      if (!s) {
        entry.reject(new RateLimitedError(op, status, bodyText));
        return;
      }
      s.remaining = 0;
      s.resetAt = Date.now() + waitMs;
      s.pausedUntil = global ? s.pausedUntil : Date.now() + waitMs;
      // Retries keep the front of their priority lane.
      const idx = s.queue.findIndex(
        (q) =>
          PRIORITY_RANK[q.spec.priority ?? "user"] > PRIORITY_RANK[entry.spec.priority ?? "user"],
      );
      if (idx < 0) s.queue.push(entry);
      else s.queue.splice(idx, 0, entry);
      if (global) armGlobalTimer(waitMs);
      else armWhileBlocked(key, s, s.pausedUntil);
    });
  }

  return {
    request(spec: DiscordRestRequestSpec): Promise<Response> {
      return new Promise<Response>((resolve, reject) => {
        const ck = spec.coalesceKey;
        if (ck) {
          const inFlight = coalesceInFlight.has(ck);
          const pending = coalescePending.get(ck);
          if (inFlight || pending) {
            if (pending) {
              // Latest wins: replace the queued body and chain the superseded
              // waiters onto the surviving request's outcome.
              const merged: PendingCoalesce = {
                spec,
                enqueuedAt: pending.enqueuedAt,
                waiters: [...pending.waiters, { resolve, reject }],
              };
              coalescePending.set(ck, merged);
            } else {
              coalescePending.set(ck, {
                spec,
                enqueuedAt: Date.now(),
                waiters: [{ resolve, reject }],
              });
            }
            return;
          }
        }
        const entry: QueuedRequest = {
          spec,
          seq: seqCounter++,
          enqueuedAt: Date.now(),
          attempts: 0,
          totalWaitedMs: 0,
          resolve,
          reject,
        };
        const key = resolveKey(spec);
        const state = getBucket(key);
        state.queue.push(entry);
        sortQueue(state.queue);
        schedule(key);
      });
    },
  };
}
