import type { ShoggothConfigFragment } from "./schema";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge JSON-like objects; later keys win. Arrays are replaced, not concatenated. */
export function deepMerge(
  base: ShoggothConfigFragment,
  overlay: ShoggothConfigFragment,
): ShoggothConfigFragment {
  const out: Record<string, unknown> = { ...base };
  for (const [k, val] of Object.entries(overlay)) {
    if (val === undefined) continue;
    const prev = out[k];
    if (isPlainObject(val) && isPlainObject(prev)) {
      out[k] = deepMerge(prev as ShoggothConfigFragment, val as ShoggothConfigFragment);
    } else {
      out[k] = val;
    }
  }
  return out as ShoggothConfigFragment;
}
