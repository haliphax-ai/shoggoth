/**
 * Shared aspect-ratio → size mapping for OpenAI-compatible media adapters.
 *
 * These sizes correspond to the values accepted by the OpenAI Images API.
 * Adapters for other providers may override or extend this mapping.
 */

export const SUPPORTED_ASPECT_RATIOS: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1792x1024",
  "9:16": "1024x1792",
  "4:3": "1536x1024",
  "3:4": "1024x1536",
};

export type AspectRatioResult =
  | { size: string; error?: undefined }
  | { size?: undefined; error: string };

/**
 * Resolve an `aspectRatio` / `size` pair into a concrete size string.
 *
 * Resolution order:
 * 1. If `aspectRatio` is provided, look it up in {@link SUPPORTED_ASPECT_RATIOS}.
 * 2. Otherwise, fall back to `size` if provided.
 * 3. Otherwise, use a sensible default (`"1024x1024"`).
 */
export function resolveImageSize(params: {
  aspectRatio?: string;
  size?: string;
}): AspectRatioResult {
  // Raw size takes precedence when no aspectRatio is given
  if (params.size && !params.aspectRatio) {
    return { size: params.size };
  }
  if (params.aspectRatio) {
    const mapped = SUPPORTED_ASPECT_RATIOS[params.aspectRatio];
    if (!mapped) {
      const supported = Object.keys(SUPPORTED_ASPECT_RATIOS).join(", ");
      return {
        error: `Unsupported aspectRatio "${params.aspectRatio}". Supported: ${supported}. Use "size" for custom dimensions.`,
      };
    }
    return { size: mapped };
  }
  // Neither provided — use default
  return { size: "1024x1024" };
}
