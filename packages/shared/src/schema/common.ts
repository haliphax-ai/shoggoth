import { z } from "zod";

// ---------------------------------------------------------------------------
// Context Levels
// ---------------------------------------------------------------------------

export const CONTEXT_LEVELS = ["none", "minimal", "light", "full"] as const;

export const contextLevelSchema = z.enum(CONTEXT_LEVELS);

export type ContextLevel = z.infer<typeof contextLevelSchema>;

export const THINKING_DISPLAY_MODES = ["full", "indicator", "none"] as const;

export const thinkingDisplaySchema = z.enum(THINKING_DISPLAY_MODES);

export type ThinkingDisplay = z.infer<typeof thinkingDisplaySchema>;

export const contextLevelToolOverrideSchema = z
  .object({
    /** Additional tools to allow at this level (added to defaults). */
    allow: z.array(z.string().min(1)).optional(),
    /** Additional tools to exclude at this level (added to defaults). */
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ContextLevelToolOverride = z.infer<typeof contextLevelToolOverrideSchema>;

export const contextLevelToolsConfigSchema = z
  .object({
    none: contextLevelToolOverrideSchema.optional(),
    minimal: contextLevelToolOverrideSchema.optional(),
    light: contextLevelToolOverrideSchema.optional(),
    full: contextLevelToolOverrideSchema.optional(),
  })
  .strict();

export const providerModelSchema = z
  .object({
    name: z.string().min(1),
    contextWindowTokens: z.number().int().positive().optional(),
    thinkingFormat: z.enum(["native", "xml-tags", "none"]).optional(),
  })
  .strict();

export type ProviderModel = z.infer<typeof providerModelSchema>;

/** Per-provider retry / failure fields shared across all provider kinds. */
export const providerRetryFields = {
  models: z.array(providerModelSchema).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  retryDelayMs: z.number().int().nonnegative().optional(),
  retryBackoffMultiplier: z.number().positive().optional(),
  markFailedDurationMs: z.number().int().positive().optional(),
};

export const responseSchemaSchema = z
  .object({
    schema: z.record(z.string(), z.unknown()),
  })
  .strict()
  .optional();

export const structuredOutputModeSchema = z.enum(["strict", "best-effort", "none"]).optional();

/** Schema for a workspace-relative path (must not start with '/'). */
export const workspaceRelativePathSchema = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("/"), {
    message: "memory paths must be workspace-relative (not absolute)",
  });

/** Default tool call timeout: 10 minutes. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 600_000;