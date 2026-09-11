import { isPlainObject } from "./utils";

/** Deep merge JSON-like objects; later keys win. Arrays are replaced, not concatenated. */
export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, val] of Object.entries(overlay)) {
    if (val === undefined) continue;
    const prev = out[k];
    if (isPlainObject(val) && isPlainObject(prev)) {
      out[k] = deepMerge(prev, val);
    } else {
      out[k] = val;
    }
  }
  return out;
}
