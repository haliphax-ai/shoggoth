export type SchemeType = "canvas" | "agent" | "fileprompt" | null;

export interface ParsedScheme {
  type: SchemeType;
  path: string;
  params: Record<string, string>;
}

const SCHEMES: [string, SchemeType][] = [
  ["openclaw-canvas://", "canvas"],
  ["openclaw-fileprompt://", "fileprompt"],
  ["openclaw://", "agent"],
];

/**
 * Parse an openclaw custom scheme URL.
 * All schemes use the same structure: scheme://path?key=value&key=value
 *
 *   openclaw://agent?message=hello&agentId=dev
 *   openclaw-fileprompt://path/to/file.md?agentId=dev
 *   openclaw-canvas://subpath
 */
export function parseOpenClawUrl(url: string): ParsedScheme | null {
  for (const [prefix, type] of SCHEMES) {
    if (!url.startsWith(prefix)) continue;
    const rest = url.slice(prefix.length);
    const qIdx = rest.indexOf("?");
    const path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    const query = qIdx >= 0 ? rest.slice(qIdx + 1) : "";
    const params: Record<string, string> = {};
    if (query)
      new URLSearchParams(query).forEach((v, k) => {
        params[k] = v;
      });
    return { type, path, params };
  }
  return null;
}
