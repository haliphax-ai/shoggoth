/** Coerce an unknown value to a `Record<string, unknown>` if it is a non-null, non-array object; `null` otherwise. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Create a JSON-RPC request id allocator that cannot exceed `Number.MAX_SAFE_INTEGER`.
 *
 * Ids are consumed in a bounded pool `[1, Number.MAX_SAFE_INTEGER]` via an internal
 * cursor, so plain `nextId++` precision loss (which would silently reuse/stall ids
 * above 2^53 - 1) can never occur. On reaching the end of the pool the cursor wraps
 * to the start, **skipping any id that is still pending** so an in-flight request can
 * never be aliased by a later one; an `onExhausted` hook fires on wrap (for logging).
 * The guard also has a no-op fast path when the counter is far from the limit, which
 * is the only branch cost in normal operation — reaching the limit via incrementing
 * would take astronomical time, so this is a defensive guard, not reachable behavior.
 */
export function createRequestIdAllocator(options?: {
  /** Called once each time the id pool wraps back to 1. Defaults to a no-op. */
  readonly onExhausted?: () => void;
  /**
   * Upper bound (inclusive) of the id pool. Defaults to `Number.MAX_SAFE_INTEGER`.
   * Lowered only in tests so the wrap/skip/exhaustion paths can be exercised.
   */
  readonly max?: number;
}): (isPending: (id: number) => boolean) => number {
  const onExhausted = options?.onExhausted ?? (() => {});
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;
  let next = 1;
  let wrapped = false;
  return (isPending) => {
    if (next <= max) {
      const id = next;
      next += 1;
      return id;
    }
    // Counter reached the end of the id pool: wrap, skipping any id still
    // pending so it cannot collide with an in-flight request.
    let candidate = 1;
    while (candidate <= max && isPending(candidate)) {
      candidate += 1;
    }
    if (candidate > max) {
      throw new Error("JSON-RPC request id space exhausted: no free request id remains");
    }
    next = candidate + 1;
    if (!wrapped) {
      wrapped = true;
      onExhausted();
    }
    return candidate;
  };
}

/** Convert a JSON-RPC error object (or plain string) into a standard `Error` with code suffix. */
export function jsonRpcErrorToError(err: unknown): Error {
  const o = asRecord(err);
  if (!o) {
    return new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
  const msg = typeof o.message === "string" ? o.message : JSON.stringify(err);
  const code = o.code;
  const suffix = code !== undefined ? ` (code ${String(code)})` : "";
  return new Error(`${msg}${suffix}`);
}
