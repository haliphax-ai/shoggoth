import { access, constants } from "node:fs/promises";
import { dirname } from "node:path";
import { setModelMetadataFromProvider, getOpenAIKnownContextWindow } from "./model-metadata";

export type HealthStatus = "pass" | "fail" | "warn" | "skipped";

export interface DependencyCheck {
  name: string;
  status: HealthStatus;
  detail?: string;
  latencyMs?: number;
}

interface DependencyProbe {
  readonly name: string;
  check(): Promise<DependencyCheck>;
}

export interface HealthSnapshot {
  ok: boolean;
  live: true;
  ready: boolean;
  checks: DependencyCheck[];
  at: string;
}

async function probeSqliteFilesystem(dbPath: string): Promise<DependencyCheck> {
  const name = "sqlite";
  try {
    await access(dbPath, constants.F_OK);
    await access(dbPath, constants.R_OK | constants.W_OK);
    return { name, status: "pass" };
  } catch {
    try {
      await access(dirname(dbPath), constants.W_OK);
      return {
        name,
        status: "pass",
        detail: "parent directory writable; database file created on first open",
      };
    } catch {
      return {
        name,
        status: "fail",
        detail: "cannot access database file or parent directory",
      };
    }
  }
}

/**
 * Aggregates liveness (implicit) and readiness from dependency probes.
 * Probes with status `skipped` do not affect readiness (e.g. optional platform probes when not configured).
 */
export class HealthRegistry {
  private readonly probes: DependencyProbe[] = [];

  register(probe: DependencyProbe): () => void {
    this.probes.push(probe);
    return () => {
      const i = this.probes.indexOf(probe);
      if (i >= 0) this.probes.splice(i, 1);
    };
  }

  async snapshot(options?: { strict?: boolean }): Promise<HealthSnapshot> {
    const strict = options?.strict ?? false;
    const checks: DependencyCheck[] = [];
    for (const p of this.probes) {
      const started = performance.now();
      try {
        const c = await p.check();
        checks.push({
          ...c,
          latencyMs: c.latencyMs ?? Math.round(performance.now() - started),
        });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        checks.push({
          name: p.name,
          status: "fail",
          detail: err,
          latencyMs: Math.round(performance.now() - started),
        });
      }
    }

    const badForReady = (c: DependencyCheck) =>
      c.status === "fail" || (strict && c.status === "warn");

    const considered = checks.filter((c) => c.status !== "skipped");
    const ready =
      considered.length === 0 ? true : !considered.some(badForReady);

    const ok = !checks.some((c) => c.status === "fail");

    return {
      ok,
      live: true,
      ready,
      checks,
      at: new Date().toISOString(),
    };
  }
}

/** Filesystem reachability for state DB path; future: `PRAGMA quick_check` via open pool. */
export function createSqliteProbe(options: {
  name?: string;
  getPath: () => string | undefined;
}): DependencyProbe {
  const name = options.name ?? "sqlite";
  return {
    name,
    async check(): Promise<DependencyCheck> {
      const path = options.getPath();
      if (!path) {
        return {
          name,
          status: "skipped",
          detail: "no database path configured",
        };
      }
      return probeSqliteFilesystem(path);
    },
  };
}

const PROBE_TIMEOUT_MS = 5000;

/** Prepends `http://` when missing (e.g. `OLLAMA_HOST=localhost:11434`). */
function normalizeModelBaseUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (!/^https?:\/\//i.test(t)) return `http://${t}`;
  return t;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** True when probe base matches `ANTHROPIC_BASE_URL` (Messages API origin); use `/` not OpenAI `/v1/models`. */
function isAnthropicModelProbeBase(normalizedBase: string): boolean {
  const a = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!a) return false;
  return stripTrailingSlash(normalizeModelBaseUrl(a)) === stripTrailingSlash(normalizedBase);
}

/** True when the URL is a Google Generative AI endpoint (uses ?key= auth, native /v1beta/models path). */
function isGoogleGenAI(normalizedBase: string): boolean {
  try {
    return new URL(normalizedBase).hostname.includes("generativelanguage.googleapis.com");
  } catch {
    return false;
  }
}

/** OpenAI-style roots use `/v1/models`; Anthropic origins probe `/`; Google GenAI uses native `/v1beta/models`. */
function resolveModelProbeUrl(normalizedBase: string, apiKey?: string): string {
  const u = new URL(normalizedBase);
  const p = u.pathname.replace(/\/+$/, "") || "/";

  // Google GenAI: use native models endpoint with ?key= auth (not OpenAI-compat path)
  if (isGoogleGenAI(normalizedBase)) {
    const modelsUrl = new URL("/v1beta/models", u.origin);
    if (apiKey) modelsUrl.searchParams.set("key", apiKey);
    return modelsUrl.href;
  }

  if (p === "/" && isAnthropicModelProbeBase(normalizedBase)) {
    return `${u.origin}/`;
  }
  if (p === "/") {
    return new URL("/v1/models", u.origin).href;
  }
  // Non-root path (e.g. /v1beta/openai) — append /models for OpenAI-compat endpoints
  return new URL(`${p}/models`, u.origin).href;
}

async function fetchModelEndpoint(probeUrl: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const headers = { ...extraHeaders };
  let res = await fetch(probeUrl, { method: "HEAD", signal, redirect: "manual", headers });
  if (res.status === 405 || res.status === 404) {
    const signal2 = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    res = await fetch(probeUrl, {
      method: "GET",
      signal: signal2,
      redirect: "manual",
      headers: { Accept: "*/*", ...extraHeaders },
    });
  }
  return res;
}

function detailFromModelResponse(res: Response): string {
  return `HTTP ${res.status}`;
}

/** Build auth headers for model probe based on provider type. Google GenAI uses ?key= query param instead. */
function buildModelProbeAuthHeaders(
  normalizedBase: string,
  apiKey: string,
): Record<string, string> {
  if (isGoogleGenAI(normalizedBase)) return {};
  if (isAnthropicModelProbeBase(normalizedBase)) {
    return { "x-api-key": apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Fetch model metadata from the Gemini models API.
 * Returns inputTokenLimit/outputTokenLimit on success, undefined on failure.
 */
async function fetchGeminiModelMetadata(
  baseUrl: string,
  apiVersion: string,
  model: string,
  apiKey: string,
): Promise<{ inputTokenLimit?: number; outputTokenLimit?: number } | undefined> {
  try {
    const origin = baseUrl.replace(/\/+$/, "");
    const url = `${origin}/${apiVersion}/models/${model}?key=${encodeURIComponent(apiKey)}`;
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const res = await fetch(url, { method: "GET", signal, headers: { Accept: "application/json" } });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      inputTokenLimit?: number;
      outputTokenLimit?: number;
    };
    return {
      inputTokenLimit: typeof json.inputTokenLimit === "number" ? json.inputTokenLimit : undefined,
      outputTokenLimit: typeof json.outputTokenLimit === "number" ? json.outputTokenLimit : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * For each Gemini provider in the failover chain, fetch model metadata and update the metadata store.
 * Call after the initial health check passes for the model endpoint.
 */
export async function fetchGeminiMetadataForProviders(
  providers: ReadonlyArray<{ id: string; kind: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string; apiVersion?: string }>,
  failoverChain: ReadonlyArray<{ providerId: string; model: string }>,
  env: NodeJS.ProcessEnv,
  logger: { warn(msg: string, meta?: Record<string, unknown>): void },
): Promise<void> {
  const geminiProviders = new Map(
    providers
      .filter((p) => p.kind === "gemini")
      .map((p) => [p.id, p]),
  );

  for (const hop of failoverChain) {
    const provider = geminiProviders.get(hop.providerId);
    if (!provider) continue;

    const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined);
    if (!apiKey) continue;

    const baseUrl = provider.baseUrl ?? "https://generativelanguage.googleapis.com";
    const apiVersion = provider.apiVersion ?? "v1beta";

    const meta = await fetchGeminiModelMetadata(baseUrl, apiVersion, hop.model, apiKey);
    if (meta?.inputTokenLimit != null) {
      const warning = setModelMetadataFromProvider(hop.providerId, hop.model, meta.inputTokenLimit);
      if (warning) logger.warn(warning);
    }
  }
}

/**
 * Fetch model metadata from an OpenAI-compatible `/v1/models/{model}` endpoint.
 * Some providers (Ollama, vLLM, LiteLLM) return context window info; the official
 * OpenAI API does not. Falls back to a static lookup table of known OpenAI models.
 */
async function fetchOpenAIModelMetadata(
  baseUrl: string,
  model: string,
  apiKey: string,
): Promise<{ contextWindow?: number } | undefined> {
  try {
    const origin = baseUrl.replace(/\/+$/, "");
    // baseUrl for openai-compatible providers already includes /v1
    const url = `${origin}/models/${encodeURIComponent(model)}`;
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { method: "GET", signal, headers });
    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown>;
      // Various OpenAI-compatible providers use different field names:
      // - context_length (Ollama)
      // - max_model_len (vLLM)
      // - context_window (LiteLLM)
      // - max_context_length
      for (const field of ["context_length", "max_model_len", "context_window", "max_context_length"]) {
        const val = json[field];
        if (typeof val === "number" && val > 0) {
          return { contextWindow: val };
        }
      }
    }
  } catch {
    // API call failed — fall through to static lookup.
  }

  // Fall back to known OpenAI model context windows.
  const known = getOpenAIKnownContextWindow(model);
  if (known != null) return { contextWindow: known };

  return undefined;
}

/**
 * For each OpenAI-compatible provider in the failover chain, fetch model metadata
 * and update the metadata store. Call after the initial health check passes.
 */
export async function fetchOpenAIMetadataForProviders(
  providers: ReadonlyArray<{ id: string; kind: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string }>,
  failoverChain: ReadonlyArray<{ providerId: string; model: string }>,
  env: NodeJS.ProcessEnv,
  logger: { warn(msg: string, meta?: Record<string, unknown>): void },
): Promise<void> {
  const openaiProviders = new Map(
    providers
      .filter((p) => p.kind === "openai-compatible")
      .map((p) => [p.id, p]),
  );

  for (const hop of failoverChain) {
    const provider = openaiProviders.get(hop.providerId);
    if (!provider) continue;

    const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined) ?? "";
    const baseUrl = provider.baseUrl;
    if (!baseUrl) continue;

    const meta = await fetchOpenAIModelMetadata(baseUrl, hop.model, apiKey);
    if (meta?.contextWindow != null) {
      const warning = setModelMetadataFromProvider(hop.providerId, hop.model, meta.contextWindow);
      if (warning) logger.warn(warning);
    }
  }
}

/** Model API base URL reachability (HEAD, GET on 405). Optionally authenticates with an API key. */
export function createModelEndpointProbe(options: {
  getBaseUrl: () => string | undefined;
  getApiKey?: () => string | undefined;
  name?: string;
}): DependencyProbe {
  const probeName = options.name ?? "model";
  return {
    name: probeName,
    async check(): Promise<DependencyCheck> {
      const raw = options.getBaseUrl()?.trim();
      if (!raw) {
        return { name: probeName, status: "skipped", detail: "not configured" };
      }
      let probeUrl: string;
      let normalized: string;
      try {
        normalized = normalizeModelBaseUrl(raw);
        if (!normalized) {
          return { name: probeName, status: "skipped", detail: "not configured" };
        }
        const apiKeyForUrl = options.getApiKey?.()?.trim();
        probeUrl = resolveModelProbeUrl(normalized, apiKeyForUrl);
      } catch {
        return {
          name: probeName,
          status: "fail",
          detail: "invalid base URL",
        };
      }
      try {
        const apiKey = options.getApiKey?.()?.trim();
        const authHeaders = apiKey ? buildModelProbeAuthHeaders(normalized, apiKey) : {};
        const res = await fetchModelEndpoint(probeUrl, authHeaders);
        if (res.status >= 200 && res.status < 400) {
          return { name: probeName, status: "pass", detail: detailFromModelResponse(res) };
        }
        if (res.status === 401) {
          return {
            name: probeName,
            status: apiKey ? "fail" : "warn",
            detail: apiKey
              ? "API key rejected (HTTP 401)"
              : "reachable but unauthorized (HTTP 401); API key may be missing or invalid",
          };
        }
        return {
          name: probeName,
          status: "fail",
          detail: detailFromModelResponse(res),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { name: probeName, status: "fail", detail: msg };
      }
    },
  };
}
