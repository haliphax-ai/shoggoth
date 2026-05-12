/**
 * URL Scheme Constants
 */

export const SCHEME_AGENT = "shoggoth://";
export const SCHEME_FILEPROMPT = "shoggoth-fileprompt://";
export const SCHEME_CANVAS = "shoggoth-canvas://";

/**
 * Parse a shoggoth:// agent URL
 * @param url - URL to parse (e.g., 'shoggoth://session123?action=run')
 * @returns Parsed components or null if invalid
 */
export function parseAgentUrl(url: string): { sessionId: string; action?: string } | null {
  if (!url.startsWith(SCHEME_AGENT)) return null;

  const withoutScheme = url.slice(SCHEME_AGENT.length);
  const [sessionId, query] = withoutScheme.split("?");

  if (!sessionId) return null;

  const result: { sessionId: string; action?: string } = { sessionId };

  if (query) {
    const params = new URLSearchParams(query);
    if (params.has("action")) {
      result.action = params.get("action") ?? undefined;
    }
  }

  return result;
}

/**
 * Parse a shoggoth-fileprompt:// URL
 * @param url - URL to parse (e.g., 'shoggoth-fileprompt://path/to/file.txt')
 * @returns Parsed file path or null if invalid
 */
export function parseFilepromptUrl(url: string): string | null {
  if (!url.startsWith(SCHEME_FILEPROMPT)) return null;

  const filePath = url.slice(SCHEME_FILEPROMPT.length);
  return filePath || null;
}

/**
 * Parse a shoggoth-canvas:// URL
 * @param url - URL to parse (e.g., 'shoggoth-canvas://canvas123')
 * @returns Parsed canvas ID or null if invalid
 */
export function parseCanvasUrl(url: string): string | null {
  if (!url.startsWith(SCHEME_CANVAS)) return null;

  const canvasId = url.slice(SCHEME_CANVAS.length);
  return canvasId || null;
}
