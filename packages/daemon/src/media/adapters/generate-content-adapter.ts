import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MediaAdapterRequest, MediaAdapterResult } from "./types";

function getResponseModalities(params: MediaAdapterRequest["params"]): string[] {
  switch (params.kind) {
    case "image":
      return ["IMAGE"];
    case "speech":
    case "music":
      return ["AUDIO"];
    default:
      return ["IMAGE"];
  }
}

function buildGenerationConfig(req: MediaAdapterRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {
    responseModalities: getResponseModalities(req.params),
  };

  if (req.params.kind === "speech" && req.params.voice) {
    config.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: req.params.voice,
        },
      },
    };
  }

  return config;
}

async function buildParts(req: MediaAdapterRequest): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = [];

  // If input_image is provided, include it as an inlineData part
  if (req.params.kind === "image" && req.params.input_image) {
    const imageBytes = await readFile(req.params.input_image);
    const base64Data = imageBytes.toString("base64");
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: base64Data,
      },
    });
  }

  parts.push({ text: req.prompt });
  return parts;
}

export async function generateContentAdapter(
  req: MediaAdapterRequest,
): Promise<MediaAdapterResult> {
  try {
    const url = `${req.baseUrl}/v1beta/models/${req.model}:generateContent?key=${req.apiKey}`;
    const parts = await buildParts(req);

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: buildGenerationConfig(req),
    };

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
    const candidate = json.candidates?.[0];
    const inlinePart = candidate?.content?.parts?.find(
      (p: { inlineData?: unknown }) => p.inlineData,
    );

    if (!inlinePart?.inlineData) {
      return {
        status: "error",
        error: "No inlineData found in response",
      };
    }

    const { mimeType, data } = inlinePart.inlineData;
    const decoded = Buffer.from(data, "base64");

    await mkdir(dirname(req.outputPath), { recursive: true });
    await writeFile(req.outputPath, decoded);

    return {
      status: "complete",
      path: req.outputPath,
      mime_type: mimeType,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
