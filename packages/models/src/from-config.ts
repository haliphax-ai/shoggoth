import type { ShoggothModelsConfig } from "@shoggoth/shared";
import { createAnthropicMessagesProvider } from "./anthropic-messages";
import { createFailoverModelClient, type FailoverModelClient } from "./failover";
import { createGeminiProvider } from "./gemini";
import { createOpenAICompatibleProvider, type FetchLike } from "./openai-compatible";
import type { CompactionPolicy } from "./compaction";
import type { ModelProvider } from "./types";
import {
  createFailoverToolCallingClient,
  type FailoverToolCallingClient,
} from "./tool-failover";

export interface CreateFailoverFromConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchLike;
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
    });
    const model = env.SHOGGOTH_MODEL?.trim() || "claude-3-5-sonnet-20241022";
    return { provider, model };
  }

  if (env.GEMINI_API_KEY) {
    const provider = createGeminiProvider({
      id: "env-default",
      apiKey: env.GEMINI_API_KEY,
      baseUrl: env.GEMINI_BASE_URL,
      fetchImpl,
    });
    const model = env.SHOGGOTH_MODEL?.trim() || "gemini-2.5-flash";
    return { provider, model };
  }

  const baseRaw =
    env.OPENAI_BASE_URL ?? env.OLLAMA_HOST ?? "https://api.openai.com/v1";
  const provider = createOpenAICompatibleProvider({
    id: "env-default",
    baseUrl: normalizeOpenAIBaseUrl(baseRaw),
    apiKey: env.OPENAI_API_KEY,
    fetchImpl,
  });
  const model = env.SHOGGOTH_MODEL?.trim() || "gpt-4o-mini";
  return { provider, model };
}

/**
 * Single-provider fallback from environment when `models.failoverChain` is not set.
 */
function envBackedFailover(
  env: NodeJS.ProcessEnv,
  fetchImpl?: FetchLike,
): FailoverModelClient {
  const { provider, model } = singleHopFromEnv(env, fetchImpl);
  return createFailoverModelClient([{ provider, model }]);
}

export function createFailoverClientFromModelsConfig(
  models: ShoggothModelsConfig | undefined,
  options: CreateFailoverFromConfigOptions = {},
): FailoverModelClient {
  const env = options.env ?? process.env;
  const chain = models?.failoverChain;
  const providers = models?.providers;

  if (!chain?.length) {
    return envBackedFailover(env, options.fetchImpl);
  }

  const byId = modelProvidersById(providers, env, options.fetchImpl);

  const entries = chain.map((hop) => {
    const provider = byId.get(hop.providerId);
    if (!provider) {
      throw new Error(`Unknown model provider id "${hop.providerId}" in failoverChain`);
    }
    return { provider, model: hop.model };
  });

  return createFailoverModelClient(entries);
}

export function createFailoverToolCallingClientFromModelsConfig(
  models: ShoggothModelsConfig | undefined,
  options: CreateFailoverFromConfigOptions = {},
): FailoverToolCallingClient {
  const env = options.env ?? process.env;
  const chain = models?.failoverChain;
  const providers = models?.providers;

  if (!chain?.length) {
    const { provider, model } = singleHopFromEnv(env, options.fetchImpl);
    return createFailoverToolCallingClient([{ provider, model }]);
  }

  const byId = modelProvidersById(providers, env, options.fetchImpl);

  const entries = chain.map((hop) => {
    const provider = byId.get(hop.providerId);
    if (!provider) {
      throw new Error(`Unknown model provider id "${hop.providerId}" in failoverChain`);
    }
    return { provider, model: hop.model };
  });

  return createFailoverToolCallingClient(entries);
}

const DEFAULT_MAX_CONTEXT_CHARS = 80_000;
const DEFAULT_PRESERVE_RECENT = 8;

export function resolveCompactionPolicyFromModelsConfig(
  models: ShoggothModelsConfig | undefined,
): CompactionPolicy {
  const c = models?.compaction;
  return {
    maxContextChars: c?.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS,
    preserveRecentMessages: c?.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT,
    summaryMaxOutputTokens: c?.summaryMaxOutputTokens,
  };
}
