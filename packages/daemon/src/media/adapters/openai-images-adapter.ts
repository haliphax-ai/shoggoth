import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MediaAdapterRequest, MediaAdapterResult, ImageGenerateParams } from "./types";
import { normalizeBaseUrl } from "./utils";
import { resolveImageSize } from "./aspect-ratio-utils";

export async function openAIImagesAdapter(req: MediaAdapterRequest): Promise<MediaAdapterResult> {
  try {
    const { baseUrl, apiKey } = req.provider;
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const imageParams = req.params as ImageGenerateParams;
    const resolved = resolveImageSize(imageParams);
    if (resolved.error) {
      return { status: "error", error: resolved.error };
    }
    const response = await fetch(`${normalizedBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        n: 1,
        size: resolved.size,
        response_format: "b64_json",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "error",
        error: `API error ${response.status}: ${errorText}`,
      };
    }

    const json = (await response.json()) as {
      data: Array<{ b64_json?: string; url?: string }>;
    };

    const imageData = json.data?.[0];
    if (!imageData) {
      return {
        status: "error",
        error: "No image data in response",
      };
    }

    let imageBytes: Buffer;

    if (imageData.b64_json) {
      imageBytes = Buffer.from(imageData.b64_json, "base64");
    } else if (imageData.url) {
      // Download from URL
      const imageResponse = await fetch(imageData.url, { method: "GET" });
      if (!imageResponse.ok) {
        return {
          status: "error",
          error: `Failed to download image: ${imageResponse.status}`,
        };
      }
      const arrayBuffer = await imageResponse.arrayBuffer();
      imageBytes = Buffer.from(arrayBuffer);
    } else {
      return {
        status: "error",
        error: "No b64_json or url in response",
      };
    }

    await mkdir(dirname(req.outputPath), { recursive: true });
    await writeFile(req.outputPath, imageBytes);

    return {
      status: "complete",
      path: req.outputPath,
      mime_type: "image/png",
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
