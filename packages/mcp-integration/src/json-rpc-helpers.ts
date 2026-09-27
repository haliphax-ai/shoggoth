/** Coerce an unknown value to a `Record<string, unknown>` if it is a non-null, non-array object; `null` otherwise. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Allocates JSON-RPC request ids from `[1, max]`; wraps past the end, skipping any
 * id still pending so in-flight requests are never aliased.
 */
export function createRequestIdAllocator(options?: {
  /** Called once each time the id pool wraps back to 1. Defaults to a no-op. */
  readonly onExhausted?: () => void;
  /** Upper bound (inclusive) of the id pool. Defaults to `Number.MAX_SAFE_INTEGER` (lowered in tests only). */
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
    // Wrap past the end, skipping ids still pending.
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
