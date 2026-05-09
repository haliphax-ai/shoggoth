import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MediaAdapterRequest, MediaAdapterResult } from "./types";
import { normalizeBaseUrl } from "./utils";

/**
 * Parse a data URI and extract mime type and base64 content.
 * Expected format: data:<mime>;base64,<data>
 */
function parseDataUri(dataUri: string): { mime: string; data: Buffer } | null {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  const [, mime, base64Data] = match;
  return {
    mime,
    data: Buffer.from(base64Data, "base64"),
  };
}

/**
 * Infer MIME type from a URL or default to image/png.
 */
function inferMimeFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".svg")) return "image/svg+xml";
  return "image/png";
}

/**
 * Extract image bytes from a URL string.
 * Handles data URIs, HTTP URLs, and raw base64.
 */
async function extractImageBytes(url: string): Promise<{ data: Buffer; mime: string } | null> {
  // Try data URI first
  const parsed = parseDataUri(url);
  if (parsed) {
    return parsed;
  }

  // Try as HTTP(S) URL — download the image
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const imageResponse = await fetch(url, { method: "GET" });
      if (!imageResponse.ok) {
        return null;
      }
      const contentType = imageResponse.headers.get("content-type") || inferMimeFromUrl(url);
      const arrayBuffer = await imageResponse.arrayBuffer();
      return {
        data: Buffer.from(arrayBuffer),
        mime: contentType.split(";")[0].trim(),
      };
    } catch {
      return null;
    }
  }

  // Try as raw base64 (no data: prefix) — must be reasonably long
  if (url.length > 200 && /^[A-Za-z0-9+/]/.test(url)) {
    try {
      const data = Buffer.from(url, "base64");
      if (data.length > 100) {
        return { data, mime: "image/png" };
      }
    } catch {
      // Not valid base64
    }
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/**
 * Recursively search for image data in a response object.
 * Looks for base64 data, URLs, or data URIs in common locations.
 */
function findImageInObject(obj: AnyObj, depth = 0): string | null {
  if (depth > 5 || !obj || typeof obj !== "object") return null;

  // Direct fields that commonly hold image data
  if (obj.b64_json && typeof obj.b64_json === "string") {
    return `data:image/png;base64,${obj.b64_json}`;
  }
  if (obj.image_url?.url && typeof obj.image_url.url === "string") {
    return obj.image_url.url;
  }
  if (
    obj.url &&
    typeof obj.url === "string" &&
    (obj.url.startsWith("data:image") || obj.url.startsWith("http") || obj.url.length > 200)
  ) {
    return obj.url;
  }
  if (obj.source?.data && obj.source?.media_type) {
    return `data:${obj.source.media_type};base64,${obj.source.data}`;
  }
  // OpenAI native format: content part with type "image" and base64 data
  if (obj.type === "image" && obj.data && typeof obj.data === "string") {
    const mime = obj.mime_type || obj.media_type || "image/png";
    return `data:${mime};base64,${obj.data}`;
  }

  // Recurse into arrays
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findImageInObject(item, depth + 1);
      if (found) return found;
    }
  }

  // Recurse into object values
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const found = findImageInObject(val as AnyObj, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

export async function openAIChatImageAdapter(
  req: MediaAdapterRequest,
): Promise<MediaAdapterResult> {
  try {
    const { baseUrl, apiKey } = req.provider;
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const modalities = req.modalities ?? ["image"];

    const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        modalities,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "error",
        error: `API error ${response.status}: ${errorText}`,
      };
    }

    const json = (await response.json()) as AnyObj;

    // Try to find image data anywhere in the response
    const imageUrl = findImageInObject(json);

    if (imageUrl) {
      const extracted = await extractImageBytes(imageUrl);
      if (extracted) {
        await mkdir(dirname(req.outputPath), { recursive: true });
        await writeFile(req.outputPath, extracted.data);
        return {
          status: "complete",
          path: req.outputPath,
          mime_type: extracted.mime,
        };
      }
      return {
        status: "error",
        error: `Found image reference but could not extract bytes: ${imageUrl.slice(0, 100)}...`,
      };
    }

    // No image found — return diagnostic info
    const snippet = JSON.stringify(json).slice(0, 800);
    return {
      status: "error",
      error: `No image content found in response. Response: ${snippet}`,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
