import type { ShoggothModelsConfig } from "@shoggoth/shared";
import { createAnthropicMessagesProvider } from "./anthropic-messages";
import {
  createFailoverModelClient,
  type FailoverModelClient,
  type FailoverHooks,
} from "./failover";
import { createGeminiProvider } from "./gemini";
import { createOpenAICompatibleProvider, type FetchLike } from "./openai-compatible";
import type { CompactionPolicy } from "./compaction";
import type { ModelProvider } from "./types";
import { createFailoverToolCallingClient, type FailoverToolCallingClient } from "./tool-failover";
import type { ModelResilienceGate } from "./resilience";

export interface CreateFailoverFromConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchLike;
  readonly hooks?: FailoverHooks;
  /** Optional resilience gate to inject into providers; falls back to the global singleton. */
  readonly resilienceGate?: ModelResilienceGate;
}

function normalizeOpenAIBaseUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (t.endsWith("/v1")) return t;
  return `${t}/v1`;
}

function modelProvidersById(
  providers: ShoggothModelsConfig["providers"],
  env: NodeJS.ProcessEnv,
  fetchImpl?: FetchLike,
  resilienceGate?: ModelResilienceGate,
): Map<string, ModelProvider> {
  const byId = new Map<string, ModelProvider>();
  for (const p of providers ?? []) {
    if (p.kind === "openai-compatible") {
      const apiKey = p.apiKey ?? (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined);
      byId.set(
        p.id,
        createOpenAICompatibleProvider({
          id: p.id,
          baseUrl: normalizeOpenAIBaseUrl(p.baseUrl),
          apiKey,
          fetchImpl,
          resilienceGate,
        }),
      );
    } else if (p.kind === "anthropic-messages") {
      const apiKey = p.apiKey ?? (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined);
      byId.set(
        p.id,
        createAnthropicMessagesProvider({
          id: p.id,
          baseUrl: p.baseUrl,
          apiKey,
          anthropicVersion: p.anthropicVersion,
          auth: p.auth,
          fetchImpl,
          resilienceGate,
        }),
      );
    } else if (p.kind === "gemini") {
      const apiKey = p.apiKey ?? (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined);
      byId.set(
        p.id,
        createGeminiProvider({
          id: p.id,
          baseUrl: p.baseUrl,
          apiKey,
          apiVersion: p.apiVersion,
          fetchImpl,
          resilienceGate,
        }),
      );
    }
  }
  return byId;
}

/**
 * Single-hop provider from environment when `models.failoverChain` is not set.
 * Prefers Anthropic when `ANTHROPIC_BASE_URL` is set; otherwise OpenAI-compatible.
 */
function singleHopFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl?: FetchLike,
  resilienceGate?: ModelResilienceGate,
): { provider: ModelProvider; model: string } {
  const anthropicOrigin = env.ANTHROPIC_BASE_URL?.trim();
  if (anthropicOrigin) {
    const provider = createAnthropicMessagesProvider({
      id: "env-default",
      baseUrl: anthropicOrigin,
      apiKey: env.ANTHROPIC_API_KEY,
      anthropicVersion: env.ANTHROPIC_VERSION,
      auth: env.ANTHROPIC_AUTH?.trim().toLowerCase() === "bearer" ? "bearer" : undefined,
      fetchImpl,
      resilienceGate,
    });
    const model = env.SHOGGOTH_MODEL?.trim();
    if (!model) {
      throw new Error(
        "SHOGGOTH_MODEL environment variable is required when using env-based provider fallback (detected Anthropic via ANTHROPIC_BASE_URL). Set models.failoverChain in your config, or export SHOGGOTH_MODEL.",
      );
    }
    return { provider, model };
  }

  if (env.GEMINI_API_KEY) {
    const provider = createGeminiProvider({
      id: "env-default",
      apiKey: env.GEMINI_API_KEY,
      baseUrl: env.GEMINI_BASE_URL,
      fetchImpl,
      resilienceGate,
    });
    const model = env.SHOGGOTH_MODEL?.trim();
    if (!model) {
      throw new Error(
        "SHOGGOTH_MODEL environment variable is required when using env-based provider fallback (detected Gemini via GEMINI_API_KEY). Set models.failoverChain in your config, or export SHOGGOTH_MODEL.",
      );
    }
    return { provider, model };
  }

  const baseRaw = env.OPENAI_BASE_URL ?? env.OLLAMA_HOST ?? "https://api.openai.com/v1";
  const provider = createOpenAICompatibleProvider({
    id: "env-default",
    baseUrl: normalizeOpenAIBaseUrl(baseRaw),
    apiKey: env.OPENAI_API_KEY,
    fetchImpl,
    resilienceGate,
  });
  const model = env.SHOGGOTH_MODEL?.trim();
  if (!model) {
    throw new Error(
      "SHOGGOTH_MODEL environment variable is required when using env-based provider fallback (detected OpenAI-compatible via OPENAI_BASE_URL or OLLAMA_HOST). Set models.failoverChain in your config, or export SHOGGOTH_MODEL.",
    );
  }
  return { provider, model };
}

/**
 * Single-provider fallback from environment when `models.failoverChain` is not set.
 */
function envBackedFailover(
  env: NodeJS.ProcessEnv,
  fetchImpl?: FetchLike,
  hooks?: FailoverHooks,
  resilienceGate?: ModelResilienceGate,
): FailoverModelClient {
  const { provider, model } = singleHopFromEnv(env, fetchImpl, resilienceGate);
  return createFailoverModelClient([{ provider, model }], hooks);
}

export function createFailoverClientFromModelsConfig(
  models: ShoggothModelsConfig | undefined,
  options: CreateFailoverFromConfigOptions = {},
): FailoverModelClient {
  const env = options.env ?? process.env;
  const chain = models?.failoverChain;
  const providers = models?.providers;

  if (!chain?.length) {
    return envBackedFailover(env, options.fetchImpl, options.hooks, options.resilienceGate);
  }

  const byId = modelProvidersById(providers, env, options.fetchImpl, options.resilienceGate);

  const entries = chain.map((entry) => {
    const slash = entry.indexOf("/");
    if (slash < 1 || slash === entry.length - 1) {
      throw new Error(`Invalid failover chain entry "${entry}" — expected "providerId/model"`);
    }
    const providerId = entry.slice(0, slash);
    const modelName = entry.slice(slash + 1);
    const provider = byId.get(providerId);
    if (!provider) {
      throw new Error(`Unknown model provider id "${providerId}" in failoverChain`);
    }
    const providerConfig = providers?.find((p) => p.id === providerId);
    const modelConfig = providerConfig?.models?.find((m) => m.name === modelName);
    return {
      provider,
      model: modelName,
      thinkingFormat: modelConfig?.thinkingFormat,
      contextWindowTokens: modelConfig?.contextWindowTokens,
    };
  });

  const client = createFailoverModelClient(entries, options.hooks);
  return client;
}

export function createFailoverToolCallingClientFromModelsConfig(
  models: ShoggothModelsConfig | undefined,
  options: CreateFailoverFromConfigOptions = {},
): FailoverToolCallingClient {
  const env = options.env ?? process.env;
  const chain = models?.failoverChain;
  const providers = models?.providers;

  if (!chain?.length) {
    const { provider, model } = singleHopFromEnv(env, options.fetchImpl, options.resilienceGate);
    return createFailoverToolCallingClient([{ provider, model }], options.hooks);
  }

  const byId = modelProvidersById(providers, env, options.fetchImpl, options.resilienceGate);

  const entries = chain.map((entry) => {
    const slash = entry.indexOf("/");
    if (slash < 1 || slash === entry.length - 1) {
      throw new Error(`Invalid failover chain entry "${entry}" — expected "providerId/model"`);
    }
    const providerId = entry.slice(0, slash);
    const modelName = entry.slice(slash + 1);
    const provider = byId.get(providerId);
    if (!provider) {
      throw new Error(`Unknown model provider id "${providerId}" in failoverChain`);
    }
    const providerConfig = providers?.find((p) => p.id === providerId);
    const modelConfig = providerConfig?.models?.find((m) => m.name === modelName);
    return {
      provider,
      model: modelName,
      thinkingFormat: modelConfig?.thinkingFormat,
      contextWindowTokens: modelConfig?.contextWindowTokens,
    };
  });

  const client = createFailoverToolCallingClient(entries, options.hooks);
  return client;
}

const DEFAULT_PRESERVE_RECENT = 8;

export function resolveCompactionPolicyFromModelsConfig(
  models: ShoggothModelsConfig | undefined,
): CompactionPolicy {
  const c = models?.compaction;
  return {
    preserveRecentMessages: c?.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT,
    summaryMaxOutputTokens: c?.summaryMaxOutputTokens,
  };
}
