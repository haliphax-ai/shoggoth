import { z } from "zod";
import { workspaceRelativePathSchema } from "./common";

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const shoggothMemoryEmbeddingsConfigSchema = z
  .object({
    enabled: z.boolean(),
    modelId: z.string().min(1).optional(),
    /** OpenAI-compatible API origin; normalized to `/v1`. Merged into `SHOGGOTH_MEMORY_OPENAI_BASE_URL` when unset. */
    openaiBaseUrl: z.string().min(1).optional(),
    /** Bare API key value. Takes precedence over `apiKeyEnv`. */
    apiKey: z.string().min(1).optional(),
    /** Env var holding the API key (default `OPENAI_API_KEY`). */
    apiKeyEnv: z.string().min(1).optional(),
  })
  .strict();

export type ShoggothMemoryEmbeddingsConfig = z.infer<typeof shoggothMemoryEmbeddingsConfigSchema>;

export const shoggothMemoryConfigSchema = z
  .object({
    /** Workspace-relative roots scanned recursively for `*.md`. */
    paths: z.array(workspaceRelativePathSchema),
    embeddings: shoggothMemoryEmbeddingsConfigSchema,
  })
  .strict();

export type ShoggothMemoryConfig = z.infer<typeof shoggothMemoryConfigSchema>;

export const DEFAULT_MEMORY_CONFIG: ShoggothMemoryConfig = {
  paths: ["memory"],
  embeddings: { enabled: false },
};