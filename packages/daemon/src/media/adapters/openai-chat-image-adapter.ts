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

export async function openAIChatImageAdapter(
  req: MediaAdapterRequest,
): Promise<MediaAdapterResult> {
  try {
    const { baseUrl, apiKey } = req.provider;
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        modalities: ["text", "image"],
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
      choices: Array<{
        message: {
          content: Array<{
            type: string;
            image_url?: { url: string };
            text?: string;
          }>;
        };
      }>;
    };

    const message = json.choices?.[0]?.message;
    if (!message?.content) {
      return {
        status: "error",
        error: "No image content in response",
      };
    }

    // Find the part with type 'image_url'
    const imagePart = message.content.find((part) => part.type === "image_url");

    if (!imagePart?.image_url?.url) {
      return {
        status: "error",
        error: "No image content in response",
      };
    }

    const parsed = parseDataUri(imagePart.image_url.url);
    if (!parsed) {
      return {
        status: "error",
        error: "Invalid image data URI",
      };
    }

    await mkdir(dirname(req.outputPath), { recursive: true });
    await writeFile(req.outputPath, parsed.data);

    return {
      status: "complete",
      path: req.outputPath,
      mime_type: parsed.mime,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
