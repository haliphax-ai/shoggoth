import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MediaAdapterRequest, MediaAdapterResult } from "./types";
import { normalizeBaseUrl } from "./utils";

interface VideoRequest extends MediaAdapterRequest {
  adapterDefaults?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function openaiVideoAsyncAdapter(req: VideoRequest): Promise<MediaAdapterResult> {
  const pollIntervalMs = req.adapterDefaults?.pollIntervalMs ?? 5000;
  const timeoutMs = req.adapterDefaults?.timeoutMs ?? 300000;

  const { apiKey, baseUrl } = req.provider;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!apiKey || !baseUrl) {
    return {
      status: "error",
      error: "Missing apiKey or baseUrl",
    };
  }

  try {
    // Submit generation request
    const submitResponse = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
      }),
    });

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      return {
        status: "error",
        error: `API error ${submitResponse.status}: ${errorText}`,
      };
    }

    const submitJson = (await submitResponse.json()) as { id?: string };

    // Extract generation_id from body or header
    let generationId = submitJson.id;
    if (!generationId) {
      const headerGenId = submitResponse.headers.get("X-Generation-Id");
      if (headerGenId) {
        generationId = headerGenId;
      }
    }

    if (!generationId) {
      return {
        status: "error",
        error: "No generation_id in response",
      };
    }

    // Poll for completion
    const startTime = Date.now();

    while (true) {
      // Check for timeout
      if (Date.now() - startTime >= timeoutMs) {
        return {
          status: "in_progress",
          operation_id: generationId,
        };
      }

      // Sleep before polling (except on first iteration)
      if (Date.now() !== startTime) {
        await sleep(pollIntervalMs);
      }

      const pollResponse = await fetch(`${normalizedBaseUrl}/generation?id=${generationId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!pollResponse.ok) {
        const errorText = await pollResponse.text();
        return {
          status: "error",
          error: `Poll error ${pollResponse.status}: ${errorText}`,
        };
      }

      const pollJson = (await pollResponse.json()) as {
        status?: string;
        video_url?: string;
      };

      if (pollJson.status === "complete") {
        if (!pollJson.video_url) {
          return {
            status: "error",
            error: "No video_url in complete response",
          };
        }

        // Download the video
        const videoResponse = await fetch(pollJson.video_url, {
          method: "GET",
        });

        if (!videoResponse.ok) {
          return {
            status: "error",
            error: `Failed to download video: ${videoResponse.status}`,
          };
        }

        const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

        // Write to output path
        await mkdir(dirname(req.outputPath), { recursive: true });
        await writeFile(req.outputPath, videoBuffer);

        return {
          status: "complete",
          path: req.outputPath,
          mime_type: "video/mp4",
        };
      }

      // If not complete, continue polling
      // Sleep for the poll interval before next iteration
      await sleep(pollIntervalMs);
    }
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
