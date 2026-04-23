import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MediaAdapterRequest, MediaAdapterResult } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 300_000;

interface LongRunningRequest extends MediaAdapterRequest {
  timeout_ms?: number;
}

function buildRequestBody(req: MediaAdapterRequest, inputImageBase64?: string) {
  const instance: Record<string, unknown> = { prompt: req.prompt };

  if (inputImageBase64) {
    instance.referenceImage = { bytesBase64Encoded: inputImageBase64 };
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

async function parseCompletedResponse(
  responseBody: Record<string, unknown>,
  outputPath: string,
): Promise<MediaAdapterResult> {
  const resp = responseBody.response as Record<string, unknown> | undefined;
  const videoResp = resp?.generateVideoResponse as Record<string, unknown> | undefined;
  const samples = videoResp?.generatedSamples as Array<Record<string, unknown>> | undefined;

  if (!samples || samples.length === 0) {
    return { status: "error", error: "No generated samples in response" };
  }

  const video = samples[0].video as Record<string, unknown> | undefined;
  if (!video) {
    return { status: "error", error: "No video data in generated sample" };
  }

  const base64Data = video.bytesBase64Encoded as string | undefined;
  if (!base64Data) {
    return { status: "error", error: "No bytesBase64Encoded in video response" };
  }

  const decoded = Buffer.from(base64Data, "base64");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, decoded);

  const encoding = (video.encoding as string) || "video/mp4";

  return {
    status: "complete",
    path: outputPath,
    mime_type: encoding,
  };
}

export async function longRunningAdapter(req: LongRunningRequest): Promise<MediaAdapterResult> {
  try {
    // Read input image if provided
    let inputImageBase64: string | undefined;
    if (req.params.kind === "video" && req.params.input_image) {
      const imageBytes = await readFile(req.params.input_image);
      inputImageBase64 = imageBytes.toString("base64");
    }

    const apiVersion = "v1beta";
    const initiateUrl = `${req.baseUrl}/${apiVersion}/models/${req.model}:predictLongRunning?key=${req.apiKey}`;
    const body = buildRequestBody(req, inputImageBase64);

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
      return parseCompletedResponse(json, req.outputPath);
    }

    // Poll loop
    const timeoutMs = req.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await sleep(DEFAULT_POLL_INTERVAL_MS);

      const pollUrl = `${req.baseUrl}/${apiVersion}/${operationName}?key=${req.apiKey}`;
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
        return parseCompletedResponse(pollJson, req.outputPath);
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
