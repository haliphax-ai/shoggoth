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

/** Model name key used to identify a model within a provider's `models` record. */
export const modelNameSchema = z.string().min(1);

export const providerModelSchema = z
  .object({
    name: modelNameSchema,
    contextWindowTokens: z.number().int().positive().optional(),
    thinkingFormat: z.enum(["native", "xml-tags", "none"]).optional(),
  })
  .strict();

export type ProviderModel = z.infer<typeof providerModelSchema>;

/** Per-model provider fields (the record body; `name` is carried by the record key). */
export const providerModelEntryBodySchema = providerModelSchema.omit({ name: true });

export type ProviderModelEntryBody = z.infer<typeof providerModelEntryBodySchema>;

/** Per-provider retry / failure fields shared across all provider kinds. */
export const providerRetryFields = {
  /** Models offered by this provider, keyed by model name. */
  models: z.record(modelNameSchema, providerModelEntryBodySchema).optional().default({}),
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

/**
 * Default maximum `yieldMs` (ms) accepted by the exec tool before it
 * backgrounds the process. Requested values above the cap are clamped to it
 * (issue #478) — overridable via `runtime.execMaxYieldMs`.
 */
export const DEFAULT_EXEC_MAX_YIELD_MS = 30_000;

/**
 * Default yield window (ms) for the session-send tool before it stops blocking
 * on the target's turn and hands the reply off to a notify handle. `0` disables
 * yielding (block until the reply arrives) — overridable via
 * `runtime.sessionSendYieldMs`.
 */
export const DEFAULT_SESSION_SEND_YIELD_MS = 30_000;
/** Default maximum TTL for lifetime-controlled units: 24 hours. */
export const DEFAULT_MAX_TTL_MS = 86_400_000;

/**
 * Resolve the configured maximum TTL (ms) from `runtime.maxTtlMs`, falling back to
 * {@link DEFAULT_MAX_TTL_MS} when unset or invalid. This value is used both as the
 * default TTL for a lifetime-controlled unit whose TTL is unspecified and as the
 * maximum cap for a provided TTL — an absent TTL never means "forever".
 */
export function resolveMaxTtlMs(cfg?: { runtime?: { maxTtlMs?: number } }): number {
  const v = cfg?.runtime?.maxTtlMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_TTL_MS;
}

/**
 * Resolve an effective TTL (ms) against the configured maximum: an absent TTL
 * defaults to `maxTtlMs`, and a provided TTL is capped at `maxTtlMs`. The result is
 * always a finite value in `(0, maxTtlMs]` — never "forever".
 */
export function clampTtlMs(value: number | undefined, maxTtlMs: number): number {
  return Math.min(value ?? maxTtlMs, maxTtlMs);
}
