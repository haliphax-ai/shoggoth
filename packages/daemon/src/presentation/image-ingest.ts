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
}

/**
 * Convert a platform attachment to a canonical ImageBlock.
 *
 * - Determines MIME type from `attachment.contentType` or infers from filename extension.
 * - Returns `null` for non-image attachments.
 * - Always fetches the URL and base64-encodes (URL passthrough disabled for gateway compatibility).
 * - Returns `null` on fetch failure or oversized images.
 */
export async function ingestAttachmentImage(
  attachment: MessageAttachment,
  options: ImageIngestOptions,
): Promise<ImageBlock | null> {
  const mediaType = resolveMediaType(attachment);
  if (!mediaType) return null;

  // Always fetch and base64-encode. URL passthrough is not reliable through
  // gateways (e.g. kiro-gateway) that may not support URL-based image sources.
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

    return { type: "image", mediaType, base64: buf.toString("base64") };
  } catch (err) {
    log.warn("image_ingest.fetch_error", {
      url: attachment.url,
      filename: attachment.filename,
      err: String(err),
    });
    return null;
  }
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
