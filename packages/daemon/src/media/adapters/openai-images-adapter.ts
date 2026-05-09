import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MediaAdapterRequest, MediaAdapterResult, ImageGenerateParams } from "./types";

function mapAspectRatio(aspectRatio?: string): string {
  switch (aspectRatio) {
    case "1:1":
      return "1024x1024";
    case "16:9":
      return "1792x1024";
    case "9:16":
      return "1024x1792";
    case "4:3":
      return "1536x1024";
    case "3:4":
      return "1024x1536";
    default:
      return "1024x1024";
  }
}

export async function openAIImagesAdapter(req: MediaAdapterRequest): Promise<MediaAdapterResult> {
  try {
    const { baseUrl, apiKey } = req.provider;
    const imageParams = req.params as ImageGenerateParams;
    const size = mapAspectRatio(imageParams.aspectRatio);

    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        n: 1,
        size,
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
