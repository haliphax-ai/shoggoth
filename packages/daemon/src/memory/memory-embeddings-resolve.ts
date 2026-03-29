import type { ShoggothMemoryConfig } from "@shoggoth/shared";
import { normalizeOpenAiEmbeddingBaseUrl } from "./openai-embeddings";

const DEFAULT_OPENAI_ORIGIN = "https://api.openai.com/v1";

export function resolveMemoryEmbeddingModelId(memory: ShoggothMemoryConfig): string {
  return memory.embeddings.modelId?.trim() || "text-embedding-3-small";
}

export function resolveMemoryEmbeddingApiKeyEnv(memory: ShoggothMemoryConfig): string {
  return memory.embeddings.apiKeyEnv?.trim() || "OPENAI_API_KEY";
}

/**
 * Base URL with `/v1` suffix for OpenAI-compatible embeddings.
 * Precedence: `SHOGGOTH_MEMORY_OPENAI_BASE_URL`, `memory.embeddings.openaiBaseUrl`,
 * `OPENAI_BASE_URL`, `OLLAMA_HOST`, `runtime.openaiBaseUrl`, default OpenAI.
 */
export function resolveMemoryEmbeddingBaseUrl(
  env: NodeJS.ProcessEnv,
  memory: ShoggothMemoryConfig,
  runtimeOpenaiBaseUrl?: string | undefined,
): string {
  const candidates = [
    env.SHOGGOTH_MEMORY_OPENAI_BASE_URL?.trim(),
    memory.embeddings.openaiBaseUrl?.trim(),
    env.OPENAI_BASE_URL?.trim(),
    env.OLLAMA_HOST?.trim(),
    runtimeOpenaiBaseUrl?.trim(),
  ];
  for (const c of candidates) {
    if (c) return normalizeOpenAiEmbeddingBaseUrl(c);
  }
  return normalizeOpenAiEmbeddingBaseUrl(DEFAULT_OPENAI_ORIGIN);
}
