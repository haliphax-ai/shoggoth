/**
 * Per-media-type default model resolution for media generation.
 *
 * `mediaGeneration.defaults` holds a default model in `provider-id/model-id`
 * format for each generic media type (image, video, audio), plus optional
 * `suggestions` for specialized media types (music, tts) that are exposed as
 * hints only — never auto-applied on their own.
 */

/** Generic media type keys in `mediaGeneration.defaults`. */
export type MediaDefaultType = "image" | "video" | "audio";

/** Specialized media type keys in `mediaGeneration.defaults.suggestions`. */
export type MediaSuggestionKind = "music" | "tts";

/** The `defaults` block of `mediaGeneration` config. */
export interface ShoggothMediaGenerationDefaults {
  image?: string;
  video?: string;
  audio?: string;
  suggestions?: Partial<Record<MediaSuggestionKind, string>>;
}

/** params.kind → generic media type key in `defaults`. */
export const MEDIA_KIND_TO_DEFAULT_TYPE: Record<string, MediaDefaultType> = {
  image: "image",
  video: "video",
  speech: "audio",
  music: "audio",
};

/**
 * Resolve the default model for a generation request's `params.kind`.
 *
 * Only generic media type defaults (image, video, audio) are ever
 * auto-applied — specialized `suggestions` are hints for the agent to pass
 * explicitly, never applied here. Returns undefined when no default is
 * configured for the request's media type.
 */
export function resolveMediaDefaultModel(
  defaults: ShoggothMediaGenerationDefaults | undefined,
  kind: string,
): string | undefined {
  if (!defaults) return undefined;
  const type = MEDIA_KIND_TO_DEFAULT_TYPE[kind] as MediaDefaultType | undefined;
  if (!type) return undefined;
  return defaults[type];
}
