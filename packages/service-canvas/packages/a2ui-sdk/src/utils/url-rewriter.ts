/**
 * Rewrites shoggoth-canvas://<session>/<path> URLs to
 * http(s)://<host>:<port>/_c/<session>/<path>
 */
export function rewriteCanvasUrl(url: string): string {
  const prefix = "shoggoth-canvas://";
  if (!url.startsWith(prefix)) return url;
  const rest = url.slice(prefix.length);
  const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  return `${location.origin}${baseUrl}/_c/${rest}`;
}
