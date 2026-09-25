/** Coerce an unknown value to a `Record<string, unknown>` if it is a non-null, non-array object; `null` otherwise. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
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
