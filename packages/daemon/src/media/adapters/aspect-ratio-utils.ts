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
 * Tiered resolution mapping for OpenRouter / OpenAI chat image API.
 *
 * Maps aspect-ratio strings to the `resolution` tier and normalized `aspect_ratio`
 * accepted by modern image-generation endpoints (e.g. GPT-image via `/chat/completions`,
 * OpenRouter Image API).
 */
export const ASPECT_RATIO_TIERS: Record<string, { resolution: string; aspect_ratio: string }> = {
  "1:1": { resolution: "2K", aspect_ratio: "1:1" },
  "16:9": { resolution: "2K", aspect_ratio: "16:9" },
  "9:16": { resolution: "2K", aspect_ratio: "9:16" },
  "4:3": { resolution: "2K", aspect_ratio: "4:3" },
  "3:4": { resolution: "2K", aspect_ratio: "3:4" },
};

export type ImageTierResult =
  | { resolution: string; aspect_ratio: string; error?: undefined }
  | { resolution?: undefined; aspect_ratio?: undefined; error: string };

/**
 * Resolve an `aspectRatio` / `size` pair into a tiered resolution + aspect_ratio
 * suitable for the OpenRouter Image API and GPT-image chat completions.
 *
 * Resolution order:
 * 1. If `aspectRatio` is provided, look it up in {@link ASPECT_RATIO_TIERS}.
 * 2. If only `size` is provided, parse it to infer a resolution tier.
 * 3. Otherwise, use sensible defaults (`"2K"` + `"1:1"`).
 */
export function resolveImageTier(params: { aspectRatio?: string; size?: string }): ImageTierResult {
  if (params.aspectRatio) {
    const mapped = ASPECT_RATIO_TIERS[params.aspectRatio];
    if (!mapped) {
      const supported = Object.keys(ASPECT_RATIO_TIERS).join(", ");
      return {
        error: `Unsupported aspectRatio "${params.aspectRatio}". Supported: ${supported}.`,
      };
    }
    return mapped;
  }
  if (params.size) {
    // Parse pixel dimensions like "1024x1024"
    const pixelMatch = params.size.match(/^(\d+)x(\d+)$/);
    if (pixelMatch) {
      const pixels = Math.max(parseInt(pixelMatch[1]), parseInt(pixelMatch[2]));
      const tier = pixelsToTier(pixels);
      return { resolution: tier, aspect_ratio: "1:1" };
    }
    // Treat as a tier string directly (e.g. "2K", "1K")
    return { resolution: params.size, aspect_ratio: "1:1" };
  }
  // Neither provided — use default
  return { resolution: "2K", aspect_ratio: "1:1" };
}

/** Convert a pixel dimension to the nearest resolution tier. */
function pixelsToTier(pixels: number): string {
  if (pixels >= 3840) return "4K";
  if (pixels >= 1920) return "2K";
  if (pixels >= 960) return "1K";
  return "512";
}

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
