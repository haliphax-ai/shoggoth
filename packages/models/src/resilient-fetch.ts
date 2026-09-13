import { ModelHttpError } from "./errors";
import { headersToRecord } from "./headers-to-record";
import { parseRateLimitHeaders, type ModelResilienceGate } from "./resilience";
import { getLogger } from "@shoggoth/shared";
import type { FetchLike } from "./openai-compatible";

const log = getLogger("models");

/** Options for creating a resilient fetcher. */
export interface CreateResilientFetcherOptions {
  /** Unique model provider identifier (used for resilience gate and logging). */
  readonly id: string;
  /** Resilience gate instance. Falls back to global singleton when omitted. */
  readonly gate: ModelResilienceGate;
  /** Fetch implementation. Defaults to globalThis.fetch. */
  readonly fetchImpl: FetchLike;
  /** Provider type string for rate-limit header parsing (e.g. "openai-compatible", "anthropic", "gemini"). */
  readonly providerType: string;
  /**
   * Format the error response body text before including in ModelHttpError.
   * Default: raw `text.slice(0, 500)`.
   */
  readonly formatErrorBody?: (text: string) => string;
}

/**
 * Create a `resilientFetch` function that wraps fetch calls with:
 * - Resilience gate execution (circuit breaker / rate limiting)
 * - Rate-limit header parsing
 * - Structured error handling (throws `ModelHttpError` on non-OK responses)
 * - Structured logging for non-ModelHttpError exceptions
 *
 * Eliminates the identical ~25-line resilientFetch definition previously
 * duplicated across every provider adapter.
 */
export function createResilientFetcher(
  options: CreateResilientFetcherOptions,
): (url: string, init: RequestInit) => Promise<Response> {
  const { id, gate, fetchImpl, providerType } = options;
  const formatBody = options.formatErrorBody ?? ((text: string) => text.slice(0, 500));

  return async function resilientFetch(targetUrl: string, init: RequestInit): Promise<Response> {
    try {
      return await gate.executeWithResilience(id, async () => {
        const res = await fetchImpl(targetUrl, init);
        try {
          const parsed = parseRateLimitHeaders(id, headersToRecord(res.headers), providerType);
          gate.getOrCreateManager(id).updateCapacity(parsed);
        } catch {
          /* ignore header parse errors */
        }
        if (!res.ok) {
          const errText = await res.text();
          throw new ModelHttpError(
            res.status,
            res.statusText || `HTTP ${res.status}`,
            formatBody(errText),
          );
        }
        return res;
      });
    } catch (err: unknown) {
      if (err instanceof ModelHttpError) throw err;
      log.warn("resilientFetch non-ModelHttpError, re-throwing", {
        modelId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

/**
 * Parse JSON text, throwing `ModelHttpError(502, ...)` on parse failure.
 * Eliminates the `try { JSON.parse(text) } catch { throw ... }` boilerplate
 * that was repeated 6+ times across provider adapters.
 */
export function safeJsonParse(text: string, errorMessage: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelHttpError(502, errorMessage, text.slice(0, 200));
  }
}

/**
 * Assert that a response has OK status, throwing `ModelHttpError` on failure.
 * Reads the response body text on error to include in the exception.
 *
 * Use this **before** reading the response body for content. On success the
 * body stream is untouched; on error the body is consumed by the helper.
 *
 * @param res - The response to check.
 * @param formatErrorBody - Optional formatter for the error body text.
 *   Default: `text.slice(0, 500)`.
 */
export async function assertResponseOk(
  res: Response,
  formatErrorBody?: (text: string) => string,
): Promise<void> {
  if (!res.ok) {
    const errText = await res.text();
    const formatted = formatErrorBody ? formatErrorBody(errText) : errText.slice(0, 500);
    throw new ModelHttpError(
      res.status,
      res.statusText || `HTTP ${res.status}`,
      formatted,
    );
  }
}

/**
 * Assert that a response has a readable body stream, throwing
 * `ModelHttpError(502, ...)` if not.
 *
 * @param res - The response to check.
 * @param streamLabel - Optional label for the error message (e.g. "Anthropic stream").
 */
export function assertResponseBody(
  res: Response,
  streamLabel?: string,
): ReadableStream<Uint8Array> {
  if (!res.body) {
    const msg = streamLabel
      ? `missing response body for ${streamLabel}`
      : "missing response body";
    throw new ModelHttpError(502, msg, undefined);
  }
  return res.body;
}
