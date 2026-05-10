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

interface OpenRouterSubmitResponse {
  id: string;
  polling_url: string;
  status: "pending";
}

interface OpenRouterPollResponse {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  unsigned_urls?: string[];
  error?: string;
}

export async function openrouterVideoAdapter(req: VideoRequest): Promise<MediaAdapterResult> {
  const pollIntervalMs = req.adapterDefaults?.pollIntervalMs ?? 30000;
  const timeoutMs = req.adapterDefaults?.timeoutMs ?? 300000;

  const { apiKey, baseUrl } = req.provider;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!apiKey || !baseUrl) {
    return {
      status: "error",
      error: "Missing apiKey or baseUrl",
    };
  }

  const videoParams = req.params;
  if (videoParams.kind !== "video") {
    return {
      status: "error",
      error: "Invalid params kind for video adapter",
    };
  }

  try {
    // Build frame_images array
    const frameImages: Array<{
      type: "image_url";
      image_url: { url: string };
      frame_type: "first_frame" | "last_frame";
    }> = [];

    // Add input_image as first_frame if provided
    if (videoParams.input_image) {
      frameImages.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${videoParams.input_image}` },
        frame_type: "first_frame",
      });
    }

    // Add last_frame if provided
    if (videoParams.last_frame) {
      frameImages.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${videoParams.last_frame}` },
        frame_type: "last_frame",
      });
    }

    // Submit generation request
    // Build request body — only include optional fields when they have values
    const requestBody: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
    };

    if (videoParams.durationSeconds) {
      requestBody.duration = videoParams.durationSeconds;
    }
    if (videoParams.aspectRatio) {
      requestBody.aspect_ratio = videoParams.aspectRatio;
    }
    if (frameImages.length > 0) {
      requestBody.frame_images = frameImages;
    }

    // Submit generation request
    const submitResponse = await fetch(`${normalizedBaseUrl}/videos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      return {
        status: "error",
        error: `API error ${submitResponse.status}: ${errorText}`,
      };
    }

    const submitJson = (await submitResponse.json()) as OpenRouterSubmitResponse;

    const jobId = submitJson.id;
    let pollingUrl = submitJson.polling_url;

    if (!jobId || !pollingUrl) {
      return {
        status: "error",
        error: "Missing id or polling_url in response",
      };
    }

    // Poll for completion
    const startTime = Date.now();

    while (true) {
      // Check for timeout
      if (Date.now() - startTime >= timeoutMs) {
        return {
          status: "in_progress",
          operation_id: jobId,
        };
      }

      // Sleep before polling (except on first iteration)
      if (Date.now() !== startTime) {
        await sleep(pollIntervalMs);
      }

      const pollResponse = await fetch(pollingUrl, {
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

      const pollJson = (await pollResponse.json()) as OpenRouterPollResponse;

      // Extract next polling URL from response headers if available
      const nextPollingUrl = pollResponse.headers.get("x-next-polling-url");
      if (nextPollingUrl) {
        pollingUrl = nextPollingUrl;
      }

      if (pollJson.status === "completed") {
        if (!pollJson.unsigned_urls || pollJson.unsigned_urls.length === 0) {
          return {
            status: "error",
            error: "No unsigned_urls in completed response",
          };
        }

        // Download the video with auth header
        const videoResponse = await fetch(pollJson.unsigned_urls[0], {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
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

      if (pollJson.status === "failed") {
        return {
          status: "error",
          error: pollJson.error || "Video generation failed",
        };
      }

      // If pending or in_progress, continue polling
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
