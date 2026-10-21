import { getLogger } from "../logging.js";
import type { FetchLike } from "@shoggoth/models";
import {
  rerankModelEntriesFromRecord,
  rerankProvidersToEntries,
  type ShoggothRerankConfig,
} from "@shoggoth/shared";

const log = getLogger("rerank-service");

// ---------------------------------------------------------------------------
// Rerank model support — Cohere-style rerank API.
//
// Implements POST {baseUrl}/v1/rerank as specified by Cohere and served
// compatibly by OpenRouter: a `query` is scored against a list of `documents`
// and results come back as `{ index, relevance_score }` pairs ordered by
// relevance (index maps to the position in the input documents array).
// ---------------------------------------------------------------------------

export interface RerankProviderConfig {
  id: string;
  kind: "cohere";
  baseUrl: string;
  apiKey: string;
  models: { name: string }[];
}

export interface RerankRequest {
  /** Model in `provider-id/model-name` format; falls back to the configured
   * `defaultModel` when omitted. */
  model?: string;
  /** The search/query text scored against the documents. */
  query: string;
  /** Candidate documents (strings) to score and order by relevance. */
  documents: string[];
  /** Optional cap on the number of results returned, honored server-side.
   * Omitting it returns all documents scored. */
  top_n?: number;
  timeout_ms?: number;
  /** Optional fetch override (tests / embedded callers). */
  fetchImpl?: FetchLike;
}

export type RerankResult =
  | {
      status: "complete";
      model: string;
      results: { index: number; relevance_score: number; document?: string }[];
      meta?: Record<string, unknown>;
    }
  | { status: "error"; error: string };

/**
 * Extract a human-readable message from a rerank error body. OpenRouter uses
 * `{error:{message,code}}`; Cohere uses `{message}`. Falls back to the raw
 * response text when neither is present (or the body is not JSON).
 */
export function extractRerankErrorMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (
      parsed?.error &&
      typeof parsed.error === "object" &&
      typeof parsed.error.message === "string" &&
      parsed.error.message
    ) {
      return parsed.error.message;
    }
    if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
    if (typeof parsed?.message === "string" && parsed.message) return parsed.message;
  } catch {
    /* not JSON — use raw text */
  }
  return bodyText;
}

export class RerankService {
  private readonly providers: RerankProviderConfig[];
  private readonly defaultModel?: string;

  constructor(config: { providers: RerankProviderConfig[]; defaultModel?: string }) {
    this.providers = config.providers;
    this.defaultModel = config.defaultModel;
  }

  static fromConfig(config: ShoggothRerankConfig): RerankService {
    const providers: RerankProviderConfig[] = rerankProvidersToEntries(config.providers).map(
      (p) => ({
        id: p.id,
        kind: "cohere",
        baseUrl: p.baseUrl,
        apiKey: p.apiKey ?? (p.apiKeyEnv ? (process.env[p.apiKeyEnv] ?? "") : ""),
        models: rerankModelEntriesFromRecord(p.models).map((m) => ({ name: m.name })),
      }),
    );

    return new RerankService({ providers, defaultModel: config.defaultModel });
  }

  /**
   * Resolve a `provider-id/model-name` reference to its provider and raw model
   * name. The provider prefix is required — it is Shoggoth's routing concern;
   * the remote API only ever sees the raw model name.
   */
  private resolveModel(
    ref: string,
  ): { provider: RerankProviderConfig; modelName: string } | undefined {
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) return undefined;
    const providerId = ref.slice(0, slash);
    const modelName = ref.slice(slash + 1);
    const provider = this.providers.find((p) => p.id === providerId);
    if (!provider) return undefined;
    if (!provider.models.some((m) => m.name === modelName)) return undefined;
    return { provider, modelName };
  }

  async rerank(req: RerankRequest): Promise<RerankResult> {
    const model = req.model ?? this.defaultModel;
    if (!model) {
      return {
        status: "error",
        error: "model is required: no model given and no default model is configured",
      };
    }

    const resolved = this.resolveModel(model);
    if (!resolved) {
      return {
        status: "error",
        error: `No provider/model found for: ${model} (expected provider-id/model-name)`,
      };
    }
    const { provider, modelName } = resolved;

    const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1/rerank`;
    const doFetch = req.fetchImpl ?? fetch;

    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          // the wire format is the raw model name — the provider prefix is
          // only Shoggoth's routing concern
          model: modelName,
          query: req.query,
          documents: req.documents,
          ...(req.top_n != null ? { top_n: req.top_n } : {}),
        }),
        ...(req.timeout_ms != null ? { signal: AbortSignal.timeout(req.timeout_ms) } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          status: "error",
          error: `Rerank error ${response.status}: ${extractRerankErrorMessage(errorText)}`,
        };
      }

      const json = (await response.json()) as {
        model?: string;
        results?: {
          index?: unknown;
          relevance_score?: unknown;
          document?: { text?: unknown } | string;
        }[];
        meta?: Record<string, unknown>;
      };

      const results: { index: number; relevance_score: number; document?: string }[] = [];
      for (const r of json.results ?? []) {
        if (typeof r?.index !== "number" || typeof r?.relevance_score !== "number") {
          log.warn("rerank_service_malformed_result", { model });
          continue;
        }
        // Cohere/OpenRouter echo the document as {text}; tolerate a plain string too
        const docText =
          typeof r.document === "string"
            ? r.document
            : typeof r.document?.text === "string"
              ? r.document.text
              : undefined;
        results.push({
          index: r.index,
          relevance_score: r.relevance_score,
          ...(docText != null ? { document: docText } : {}),
        });
      }

      return {
        status: "complete",
        model: json.model ?? modelName,
        results,
        ...(json.meta ? { meta: json.meta } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("rerank_service_rerank_failed", { error: msg, model });
      return { status: "error", error: msg };
    }
  }
}
