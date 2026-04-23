import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, basename, extname, join } from "node:path";
import type { MediaAdapterRequest, MediaAdapterResult } from "./types";

function buildRequestBody(req: MediaAdapterRequest, inputImageBase64?: string) {
  const instance: Record<string, unknown> = { prompt: req.prompt };

  if (inputImageBase64) {
    instance.image = { bytesBase64Encoded: inputImageBase64 };
  }

  const parameters: Record<string, unknown> = {
    sampleCount:
      req.params.kind === "image" && req.params.numberOfImages ? req.params.numberOfImages : 1,
    aspectRatio:
      req.params.kind === "image" && req.params.aspectRatio ? req.params.aspectRatio : "1:1",
  };

  return { instances: [instance], parameters };
}

function outputPathForIndex(basePath: string, index: number): string {
  if (index === 0) return basePath;
  const dir = dirname(basePath);
  const ext = extname(basePath);
  const name = basename(basePath, ext);
  return join(dir, `${name}_${index}${ext}`);
}

export async function predictAdapter(req: MediaAdapterRequest): Promise<MediaAdapterResult> {
  try {
    let inputImageBase64: string | undefined;
    if (req.params.kind === "image" && req.params.input_image) {
      const imageBytes = await readFile(req.params.input_image);
      inputImageBase64 = imageBytes.toString("base64");
    }

    const url = `${req.baseUrl}/v1beta/models/${req.model}:predict?key=${req.apiKey}`;
    const body = buildRequestBody(req, inputImageBase64);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "error",
        error: `API error ${response.status}: ${errorText}`,
      };
    }

    const json = await response.json();
    const predictions: Array<{ bytesBase64Encoded: string }> = json.predictions ?? [];

    if (predictions.length === 0) {
      return {
        status: "error",
        error: "No predictions found in response",
      };
    }

    await mkdir(dirname(req.outputPath), { recursive: true });

    for (let i = 0; i < predictions.length; i++) {
      const decoded = Buffer.from(predictions[i].bytesBase64Encoded, "base64");
      await writeFile(outputPathForIndex(req.outputPath, i), decoded);
    }

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
