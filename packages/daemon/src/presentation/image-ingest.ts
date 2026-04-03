import type { MessageAttachment } from "@shoggoth/messaging";
import type { ImageBlock, ImageBlockCodec } from "@shoggoth/models";
import { IMAGE_MIME_TYPES, IMAGE_EXTENSION_TO_MIME } from "@shoggoth/shared";
import { getLogger } from "../logging.js";

const log = getLogger("image-ingest");

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export interface ImageIngestOptions {
  readonly codec: ImageBlockCodec;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
  /**
   * When true AND the codec supports URL sources, pass the attachment URL
   * directly instead of fetching and base64-encoding. Only enable for
   * direct provider access (e.g. Anthropic API); gateways may not support it.
   * Default false.
   */
  readonly imageUrlPassthrough?: boolean;
}

/**
 * Convert a platform attachment to a canonical ImageBlock.
 *
 * - Determines MIME type from `attachment.contentType` or infers from filename extension.
 * - Returns `null` for non-image attachments.
 * - When `imageUrlPassthrough` is true and the codec supports URLs, returns a URL-only ImageBlock.
 * - Otherwise fetches the URL, base64-encodes, and returns a base64 ImageBlock.
 * - Returns `null` on fetch failure or oversized images.
 */
export async function ingestAttachmentImage(
  attachment: MessageAttachment,
  options: ImageIngestOptions,
): Promise<ImageBlock | null> {
  const mediaType = resolveMediaType(attachment);
  if (!mediaType) return null;

  // URL passthrough: only when explicitly enabled AND the codec supports it.
  if (options.imageUrlPassthrough && options.codec.supportsUrl) {
    return { type: "image", mediaType, url: attachment.url };
  }

  // Default: always fetch and base64-encode for gateway compatibility.
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  try {
    const res = await fetchFn(attachment.url);
    if (!res.ok) {
      log.warn("image_ingest.fetch_failed", {
        url: attachment.url,
        status: res.status,
        filename: attachment.filename,
      });
      return null;
    }

    // Check Content-Length header first (avoid downloading oversized files)
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      log.warn("image_ingest.oversized", {
        filename: attachment.filename,
        contentLength,
        maxBytes,
      });
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      log.warn("image_ingest.oversized", {
        filename: attachment.filename,
        actualBytes: buf.byteLength,
        maxBytes,
      });
      return null;
    }

    // Prefer actual bytes over declared metadata — Discord (and other
    // platforms) frequently report a content-type that doesn't match the
    // bytes they serve (e.g. "image/webp" for a PNG payload).
    const detectedType = detectMediaTypeFromBytes(buf);
    const finalMediaType = detectedType ?? mediaType;

    return { type: "image", mediaType: finalMediaType, base64: buf.toString("base64") };
  } catch (err) {
    log.warn("image_ingest.fetch_error", {
      url: attachment.url,
      filename: attachment.filename,
      err: String(err),
    });
    return null;
  }
}

/**
 * Sniff the actual image format from the first bytes of the buffer.
 * Returns the correct MIME type, or undefined if unrecognised.
 */
export function detectMediaTypeFromBytes(buf: Buffer): string | undefined {
  if (buf.length < 12) return undefined;
  // PNG: 0x89 P N G
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // JPEG: 0xFF 0xD8 0xFF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // GIF: GIF87a or GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "image/gif";
  return undefined;
}

function resolveMediaType(attachment: MessageAttachment): string | undefined {
  // Prefer explicit content type
  if (attachment.contentType && IMAGE_MIME_TYPES.has(attachment.contentType)) {
    return attachment.contentType;
  }

  // Infer from filename extension
  const filename = attachment.filename ?? "";
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx >= 0) {
    const ext = filename.slice(dotIdx).toLowerCase();
    const mime = IMAGE_EXTENSION_TO_MIME[ext];
    if (mime) return mime;
  }

  return undefined;
}
