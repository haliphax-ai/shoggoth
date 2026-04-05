import type { ImageBlock, ImageBlockCodec, ModelCapabilities } from "./types";

// ---------------------------------------------------------------------------
// OpenAI-compatible codec
// ---------------------------------------------------------------------------

export const openaiImageBlockCodec: ImageBlockCodec = {
  supportsUrl: true,
  supportsImageInput: true,

  encode(block: ImageBlock): unknown {
    const url = block.url
      ? block.url
      : `data:${block.mediaType};base64,${block.base64}`;
    return { type: "image_url", image_url: { url } };
  },

  decode(part: unknown): ImageBlock | null {
    if (
      typeof part !== "object" ||
      part === null ||
      (part as Record<string, unknown>).type !== "image_url"
    ) {
      return null;
    }
    const imageUrl = (part as Record<string, unknown>).image_url;
    if (typeof imageUrl !== "object" || imageUrl === null) return null;
    const url = (imageUrl as Record<string, unknown>).url;
    if (typeof url !== "string") return null;

    const dataUriMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (dataUriMatch) {
      return {
        type: "image",
        mediaType: dataUriMatch[1],
        base64: dataUriMatch[2],
      };
    }
    // Plain URL — infer media type from extension or default to jpeg
    return { type: "image", mediaType: inferMediaTypeFromUrl(url), url };
  },
};

// ---------------------------------------------------------------------------
// Anthropic Messages codec
// ---------------------------------------------------------------------------

export const anthropicImageBlockCodec: ImageBlockCodec = {
  supportsUrl: true,
  supportsImageInput: true,

  encode(block: ImageBlock): unknown {
    if (block.url) {
      return { type: "image", source: { type: "url", url: block.url } };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mediaType,
        data: block.base64,
      },
    };
  },

  decode(part: unknown): ImageBlock | null {
    if (
      typeof part !== "object" ||
      part === null ||
      (part as Record<string, unknown>).type !== "image"
    ) {
      return null;
    }
    const source = (part as Record<string, unknown>).source;
    if (typeof source !== "object" || source === null) return null;
    const src = source as Record<string, unknown>;

    if (src.type === "base64") {
      return {
        type: "image",
        mediaType: src.media_type as string,
        base64: src.data as string,
      };
    }
    if (src.type === "url") {
      return {
        type: "image",
        mediaType: inferMediaTypeFromUrl(src.url as string),
        url: src.url as string,
      };
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Gemini codec
// ---------------------------------------------------------------------------

export const geminiImageBlockCodec: ImageBlockCodec = {
  supportsUrl: false,
  supportsImageInput: true,

  encode(block: ImageBlock): unknown {
    if (!block.base64) {
      throw new Error(
        "Gemini codec requires base64 data; URL-only ImageBlock is not supported.",
      );
    }
    return { inlineData: { mimeType: block.mediaType, data: block.base64 } };
  },

  decode(part: unknown): ImageBlock | null {
    if (typeof part !== "object" || part === null) return null;
    const inlineData = (part as Record<string, unknown>).inlineData;
    if (typeof inlineData !== "object" || inlineData === null) return null;
    const d = inlineData as Record<string, unknown>;
    if (typeof d.mimeType !== "string" || typeof d.data !== "string") {
      return null;
    }
    return { type: "image", mediaType: d.mimeType, base64: d.data };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const codecs: Record<string, ImageBlockCodec> = {
  "openai-compatible": openaiImageBlockCodec,
  "anthropic-messages": anthropicImageBlockCodec,
  gemini: geminiImageBlockCodec,
};

export function getImageBlockCodec(
  kind: "openai-compatible" | "anthropic-messages" | "gemini",
): ImageBlockCodec {
  const codec = codecs[kind];
  if (!codec) throw new Error(`Unknown image block codec kind: ${kind}`);
  return codec;
}

// ---------------------------------------------------------------------------
// wrapCodecWithCapabilities
// ---------------------------------------------------------------------------

export function wrapCodecWithCapabilities(
  codec: ImageBlockCodec,
  capabilities: ModelCapabilities,
): ImageBlockCodec {
  if (capabilities.imageInput !== false) return codec;
  return {
    supportsUrl: codec.supportsUrl,
    supportsImageInput: false,
    encode(): unknown {
      throw new Error("Model does not support image input");
    },
    decode(part: unknown): ImageBlock | null {
      return codec.decode(part);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferMediaTypeFromUrl(url: string): string {
  const pathname = url.split("?")[0].toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
