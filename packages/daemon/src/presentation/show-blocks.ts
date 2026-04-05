// ---------------------------------------------------------------------------
// Block resolver registry for the `show` tool
// ---------------------------------------------------------------------------

import type { ChatContentPart } from "@shoggoth/models";
import { toolReadBinary } from "@shoggoth/os-exec";
import type { AgentCredentials } from "@shoggoth/os-exec";
import { detectMediaTypeFromBytes } from "./image-ingest.js";
import type { OutboundAttachment } from "./platform-adapter.js";
import type { TranscriptMessageRow } from "../sessions/transcript-store.js";
import { getLogger } from "../logging.js";
import { MAX_IMAGE_BLOCK_BYTES } from "@shoggoth/shared";

const log = getLogger("show-blocks");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShowToolParams {
  readonly type: "image";
  readonly path?: string;
  readonly url?: string;
  readonly base64?: string;
  readonly mediaType?: string;
  readonly filename?: string;
}

export type ResolvedBlock =
  | { readonly kind: "contentPart"; readonly parts: ChatContentPart[] }
  | { readonly kind: "attachment"; readonly attachments: OutboundAttachment[] };

export type BlockResolver = (
  params: ShowToolParams,
  ctx: BlockResolverContext,
) => Promise<ResolvedBlock>;

export interface BlockResolverContext {
  readonly workspacePath: string;
  readonly creds: AgentCredentials;
  readonly fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const resolvers = new Map<string, BlockResolver>();

export function registerBlockResolver(type: string, resolver: BlockResolver): void {
  resolvers.set(type, resolver);
}

export function getBlockResolver(type: string): BlockResolver | undefined {
  return resolvers.get(type);
}

// ---------------------------------------------------------------------------
// Image resolver
// ---------------------------------------------------------------------------

async function resolveImage(
  params: ShowToolParams,
  ctx: BlockResolverContext,
): Promise<ResolvedBlock> {
  const fetchFn = ctx.fetchImpl ?? globalThis.fetch;

  let buf: Buffer;
  let declaredMediaType = params.mediaType;
  let filename = params.filename;

  if (params.path) {
    // Read from workspace filesystem
    filename ??= params.path.split("/").pop() ?? "image";
    buf = await toolReadBinary(ctx.workspacePath, params.path, ctx.creds);
  } else if (params.url) {
    // Fetch from URL
    filename ??= new URL(params.url).pathname.split("/").pop() ?? "image";
    const res = await fetchFn(params.url);
    if (!res.ok) {
      throw new Error(`fetch_failed: HTTP ${res.status} for ${params.url}`);
    }
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_IMAGE_BLOCK_BYTES) {
      throw new Error(
        `oversized: ${Number(contentLength)} bytes exceeds ${MAX_IMAGE_BLOCK_BYTES} byte limit`,
      );
    }
    buf = Buffer.from(await res.arrayBuffer());
  } else if (params.base64) {
    // Decode base64
    if (!declaredMediaType) {
      throw new Error("mediaType is required when using base64 input");
    }
    buf = Buffer.from(params.base64, "base64");
    filename ??= "image";
  } else {
    throw new Error("at least one of path, url, or base64 must be provided");
  }

  if (buf.byteLength > MAX_IMAGE_BLOCK_BYTES) {
    const sizeMB = (buf.byteLength / (1024 * 1024)).toFixed(1);
    throw new Error(
      `oversized: ${sizeMB} MB exceeds ${MAX_IMAGE_BLOCK_BYTES / (1024 * 1024)} MB limit`,
    );
  }

  // Detect actual media type from magic bytes; prefer detected over declared
  const detected = detectMediaTypeFromBytes(buf);
  const finalMediaType = detected ?? declaredMediaType ?? "application/octet-stream";

  if (detected && declaredMediaType && detected !== declaredMediaType) {
    log.debug("show_image.mediatype_corrected", {
      declared: declaredMediaType,
      detected,
    });
  }

  if (!finalMediaType.startsWith("image/")) {
    throw new Error(`unsupported_format: detected type ${finalMediaType} is not an image`);
  }

  const base64 = buf.toString("base64");
  const parts: ChatContentPart[] = [
    { type: "image", mediaType: finalMediaType, base64 },
    { type: "text", text: `[show: ${filename}]` },
  ];

  return { kind: "contentPart", parts };
}

// Register the image resolver
registerBlockResolver("image", resolveImage);

// ---------------------------------------------------------------------------
// Outbound block extraction — scan tool results for `show` entries
// ---------------------------------------------------------------------------

/**
 * MIME type → common file extension mapping for generating filenames.
 */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

/**
 * Ensure a filename has an extension matching the media type.
 */
function ensureExtension(filename: string, mediaType: string): string {
  const ext = MIME_TO_EXT[mediaType];
  if (!ext) return filename;
  if (filename.includes(".")) return filename;
  return filename + ext;
}

/**
 * Scan the current turn's tool results for `show` tool entries, parse their
 * `contentParts`, and collect into `OutboundAttachment[]` suitable for
 * platform delivery.
 *
 * Tool results from `show` are stored in the transcript as role=tool rows
 * with `metadata.tool === "show"` and content that is a JSON-serialized
 * `ChatContentPart[]` containing image blocks.
 */
export function extractShowBlocks(
  turnToolResults: readonly TranscriptMessageRow[],
): OutboundAttachment[] {
  const attachments: OutboundAttachment[] = [];
  let imageIndex = 0;

  for (const row of turnToolResults) {
    if (row.role !== "tool") continue;

    // Check metadata for show tool marker
    const meta = row.metadata as Record<string, unknown> | undefined;
    if (meta?.tool !== "builtin-show") continue;

    if (!row.content) continue;

    // Parse content as ChatContentPart[]
    let parts: ChatContentPart[];
    try {
      const parsed = JSON.parse(row.content);
      if (!Array.isArray(parsed)) continue;
      parts = parsed as ChatContentPart[];
    } catch {
      continue;
    }

    // Extract image blocks and convert to OutboundAttachment
    for (const part of parts) {
      if (part.type !== "image") continue;
      const imgPart = part as ChatContentPart & { type: "image"; base64?: string; mediaType?: string };
      if (!imgPart.base64) continue;

      const mediaType = imgPart.mediaType ?? "image/png";
      const data = Buffer.from(imgPart.base64, "base64");

      // Try to derive filename from adjacent text parts like "[show: filename]"
      let filename: string | undefined;
      const idx = parts.indexOf(part);
      const next = parts[idx + 1];
      if (next?.type === "text") {
        const match = (next as { text: string }).text.match(/^\[show:\s*(.+)\]$/);
        if (match) filename = match[1];
      }

      filename ??= `image_${imageIndex}`;
      filename = ensureExtension(filename, mediaType);
      imageIndex++;

      attachments.push({ filename, contentType: mediaType, data });
    }
  }

  return attachments;
}
