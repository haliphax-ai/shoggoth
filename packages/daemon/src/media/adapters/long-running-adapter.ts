import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MediaAdapterRequest, MediaAdapterResult } from "./types";
import { getLogger } from "../../logging.js";

const log = getLogger("long-running-adapter");

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 300_000;

interface LongRunningRequest extends MediaAdapterRequest {
  timeout_ms?: number;
}

function inferImageMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function buildRequestBody(
  req: MediaAdapterRequest,
  inputImageBase64?: string,
  lastFrameBase64?: string,
) {
  const instance: Record<string, unknown> = { prompt: req.prompt };

  if (inputImageBase64) {
    const mimeType =
      req.params.kind === "video" && req.params.input_image
        ? inferImageMimeType(req.params.input_image)
        : "image/png";
    instance.image = { bytesBase64Encoded: inputImageBase64, mimeType };
  }

  if (lastFrameBase64) {
    const mimeType =
      req.params.kind === "video" && req.params.last_frame
        ? inferImageMimeType(req.params.last_frame)
        : "image/png";
    instance.lastFrame = { bytesBase64Encoded: lastFrameBase64, mimeType };
  }

  const parameters: Record<string, unknown> = {};
  if (req.params.kind === "video") {
    if (req.params.aspectRatio) parameters.aspectRatio = req.params.aspectRatio;
    if (req.params.durationSeconds) parameters.durationSeconds = req.params.durationSeconds;
  }

  return { instances: [instance], parameters };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadFromUri(uri: string, outputPath: string, apiKey?: string): Promise<Buffer> {
  const downloadUrl = apiKey ? `${uri}&key=${apiKey}` : uri;
  const res = await fetch(downloadUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Video download failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buf);
  return buf;
}

async function parseCompletedResponse(
  responseBody: Record<string, unknown>,
  outputPath: string,
  apiKey?: string,
): Promise<MediaAdapterResult> {
  const resp = responseBody.response as Record<string, unknown> | undefined;
  const videoResp = resp?.generateVideoResponse as Record<string, unknown> | undefined;
  const samples = videoResp?.generatedSamples as Array<Record<string, unknown>> | undefined;

  if (!samples || samples.length === 0) {
    log.warn("long_running.parse_failed", {
      error: "No generated samples in response",
      responseKeys: resp ? Object.keys(resp) : [],
      videoRespKeys: videoResp ? Object.keys(videoResp) : [],
      rawResponseKeys: Object.keys(responseBody),
    });
    return { status: "error", error: "No generated samples in response" };
  }

  const video = samples[0].video as Record<string, unknown> | undefined;
  if (!video) {
    log.warn("long_running.parse_failed", {
      error: "No video data in generated sample",
      sampleKeys: Object.keys(samples[0]),
    });
    return { status: "error", error: "No video data in generated sample" };
  }

  // Prefer URI download (standard Veo 3.1 response), fall back to inline base64
  const videoUri = video.uri as string | undefined;
  const base64Data = video.bytesBase64Encoded as string | undefined;
  const encoding = (video.encoding as string) || "video/mp4";

  if (videoUri) {
    try {
      await downloadFromUri(videoUri, outputPath, apiKey);
      return { status: "complete", path: outputPath, mime_type: encoding };
    } catch (err) {
      log.warn("long_running.uri_download_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to base64 if available
      if (!base64Data) {
        return {
          status: "error",
          error: `Video URI download failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  if (base64Data) {
    const decoded = Buffer.from(base64Data, "base64");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, decoded);
    return { status: "complete", path: outputPath, mime_type: encoding };
  }

  log.warn("long_running.parse_failed", {
    error: "No video URI or bytesBase64Encoded in response",
    videoKeys: Object.keys(video),
  });
  return { status: "error", error: "No video URI or bytesBase64Encoded in video response" };
}

export async function longRunningAdapter(req: LongRunningRequest): Promise<MediaAdapterResult> {
  try {
    // Read input image (first frame) if provided
    let inputImageBase64: string | undefined;
    if (req.params.kind === "video" && req.params.input_image) {
      const imageBytes = await readFile(req.params.input_image);
      inputImageBase64 = imageBytes.toString("base64");
    }

    // Read last frame if provided
    let lastFrameBase64: string | undefined;
    if (req.params.kind === "video" && req.params.last_frame) {
      const lastFrameBytes = await readFile(req.params.last_frame);
      lastFrameBase64 = lastFrameBytes.toString("base64");
    }

    const apiVersion = req.provider.apiVersion ?? "v1beta";
    const initiateUrl = `${req.provider.baseUrl}/${apiVersion}/models/${req.model}:predictLongRunning?key=${req.provider.apiKey}`;
    const body = buildRequestBody(req, inputImageBase64, lastFrameBase64);

    const response = await fetch(initiateUrl, {
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

    const json = (await response.json()) as Record<string, unknown>;
    const operationName = json.name as string;

    // If already done on first response
    if (json.done === true) {
      return parseCompletedResponse(json, req.outputPath, req.provider.apiKey);
    }

    // Poll loop
    const timeoutMs = req.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await sleep(DEFAULT_POLL_INTERVAL_MS);

      const pollUrl = `${req.provider.baseUrl}/${apiVersion}/${operationName}?key=${req.provider.apiKey}`;
      const pollResponse = await fetch(pollUrl);

      if (!pollResponse.ok) {
        const errorText = await pollResponse.text();
        return {
          status: "error",
          error: `Poll error ${pollResponse.status}: ${errorText}`,
        };
      }

      const pollJson = (await pollResponse.json()) as Record<string, unknown>;

      if (pollJson.done === true) {
        return parseCompletedResponse(pollJson, req.outputPath, req.provider.apiKey);
      }
    }

    // Timeout exceeded — return in_progress
    return {
      status: "in_progress",
      operation_id: operationName,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}