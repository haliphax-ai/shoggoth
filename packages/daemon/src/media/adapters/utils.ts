/**
 * Normalize a base URL to ensure it ends with /v1 for OpenAI-compatible APIs.
 * - Strips trailing slashes
 * - Appends /v1 if not already present
 *
 * @param baseUrl - The base URL from the provider config
 * @returns The normalized base URL ending with /v1
 */
export function normalizeBaseUrl(baseUrl: string): string {
  // Strip any trailing slash
  const stripped = baseUrl.replace(/\/$/, "");

  // If it already ends with /v1, return as-is
  if (stripped.endsWith("/v1")) {
    return stripped;
  }

  // Otherwise, append /v1
  return `${stripped}/v1`;
}
