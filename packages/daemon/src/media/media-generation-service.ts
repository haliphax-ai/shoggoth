import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getLogger } from "../logging.js";

const log = getLogger("media-generation-service");
import { generateContentAdapter } from "./adapters/generate-content-adapter";
import { predictAdapter } from "./adapters/predict-adapter";
import { longRunningAdapter } from "./adapters/long-running-adapter";
import { openAIImagesAdapter } from "./adapters/openai-images-adapter";
import { openAIChatImageAdapter } from "./adapters/openai-chat-image-adapter";
import { openaiVideoAsyncAdapter } from "./adapters/openai-video-async-adapter";
import type {
  MediaAdapterRequest,
  MediaAdapterResult,
  MediaGenerateParams,
} from "./adapters/types";
import {
  resolveModel,
  type ResolvedMediaProvider,
  type MediaGenerationModelEntry,
} from "./resolve-model.js";
import type { ShoggothMediaGenerationConfig } from "@shoggoth/shared";

export interface PollRequest {
  provider_id: string;
  operation_id: string;
  output_path?: string;
}

interface GenerateRequest {
  model: string;
  prompt: string;
  provider_id?: string;
  params: MediaGenerateParams;
  output_path: string;
  timeout_ms?: number;
}

export class MediaGenerationService {
  private readonly providers: ResolvedMediaProvider[];
  private readonly models: MediaGenerationModelEntry[];
  private readonly adapterDefaults?: Record<string, unknown>;

  constructor(config: {
    providers: ResolvedMediaProvider[];
    models: MediaGenerationModelEntry[];
    adapterDefaults?: Record<string, unknown>;
  }) {
    this.providers = config.providers;
    this.models = config.models;
    this.adapterDefaults = config.adapterDefaults;
  }

  static fromConfig(config: ShoggothMediaGenerationConfig): MediaGenerationService {
    // Resolve providers from config
    const resolvedProviders: ResolvedMediaProvider[] = (config.providers ?? []).map((p) => ({
      id: p.id,
      kind: p.kind as "openai-compatible" | "gemini",
      baseUrl: p.baseUrl,
      apiKey: p.apiKey ?? (p.apiKeyEnv ? (process.env[p.apiKeyEnv] ?? "") : ""),
      apiVersion: p.apiVersion,
    }));

    // Use models from config
    const modelEntries: MediaGenerationModelEntry[] = (config.models ?? []).map((m) => ({
      pattern: m.pattern,
      provider: m.provider,
      adapter: m.adapter,
    }));

    return new MediaGenerationService({
      providers: resolvedProviders,
      models: modelEntries,
      adapterDefaults: config.adapterDefaults,
    });
  }

  async generate(req: GenerateRequest): Promise<MediaAdapterResult> {
    const resolved = resolveModel(req.model, this.models, this.providers);
    if (!resolved) {
      // Check if a model pattern matched but provider was missing
      for (const entry of this.models) {
        const regexPattern = entry.pattern.split("*").join(".*");
        const regex = new RegExp("^" + regexPattern + "$");
        if (regex.test(req.model)) {
          const providerExists = this.providers.some((p) => p.id === entry.provider);
          if (!providerExists) {
            return {
              status: "error",
              error: `Provider not found: ${entry.provider}`,
            };
          }
        }
      }
      return {
        status: "error",
        error: `No provider/adapter found for model: ${req.model}`,
      };
    }

    const adapterName = resolved.adapter;
    const adapterReq: MediaAdapterRequest = {
      model: req.model,
      prompt: req.prompt,
      provider: resolved.provider,
      outputPath: req.output_path,
      params: req.params,
    };

    switch (adapterName) {
      case "gemini-generate-content":
        return generateContentAdapter(adapterReq);
      case "gemini-predict":
        return predictAdapter(adapterReq);
      case "gemini-long-running":
        return longRunningAdapter(adapterReq as MediaAdapterRequest & { timeout_ms?: number });
      case "openai-images":
        return openAIImagesAdapter(adapterReq);
      case "openai-chat-image":
        return openAIChatImageAdapter(adapterReq);
      case "openai-video-async":
        return openaiVideoAsyncAdapter(adapterReq);
      default:
        return {
          status: "error",
          error: `Unknown adapter: ${adapterName}`,
        };
    }
  }

  async poll(req: PollRequest): Promise<MediaAdapterResult> {
    const provider = this.providers.find((p) => p.id === req.provider_id);
    if (!provider) {
      return {
        status: "error",
        error: `Provider not found: ${req.provider_id}`,
      };
    }

    if (provider.kind !== "gemini") {
      return {
        status: "error",
        error: `Provider ${req.provider_id} is kind '${provider.kind}', but media generation requires kind 'gemini'`,
      };
    }

    const baseUrl = provider.baseUrl;
    const apiKey = provider.apiKey;
    const apiVersion = provider.apiVersion ?? "v1beta";
    const pollUrl = `${baseUrl}/${apiVersion}/${req.operation_id}?key=${apiKey}`;

    try {
      const response = await fetch(pollUrl);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          status: "error",
          error: `Poll error ${response.status}: ${errorText}`,
        };
      }

      const json = (await response.json()) as Record<string, unknown>;

      if (json.done !== true) {
        return {
          status: "in_progress",
          operation_id: req.operation_id,
        };
      }

      // Parse completed response
      const resp = json.response as Record<string, unknown> | undefined;
      const videoResp = resp?.generateVideoResponse as Record<string, unknown> | undefined;
      const samples = videoResp?.generatedSamples as Array<Record<string, unknown>> | undefined;

      if (!samples || samples.length === 0) {
        return { status: "error", error: "No generated samples in response" };
      }

      const video = samples[0].video as Record<string, unknown> | undefined;
      if (!video) {
        log.warn("media_generation_service.poll_parse_failed", {
          error: "No video data in generated sample",
          sampleKeys: Object.keys(samples[0]),
        });
        return { status: "error", error: "No video data in generated sample" };
      }

      const videoUri = video.uri as string | undefined;
      const base64Data = video.bytesBase64Encoded as string | undefined;
      const encoding = (video.encoding as string) || "video/mp4";
      const outputPath =
        req.output_path || `/tmp/media/${req.operation_id.replace(/\//g, "_")}.mp4`;

      // Prefer URI download (standard Veo 3.1 response), fall back to inline base64
      if (videoUri) {
        try {
          const downloadUrl = apiKey ? `${videoUri}&key=${apiKey}` : videoUri;
          const dlRes = await fetch(downloadUrl, { redirect: "follow" });
          if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`);
          const buf = Buffer.from(await dlRes.arrayBuffer());
          await mkdir(dirname(outputPath), { recursive: true });
          await writeFile(outputPath, buf);
          return { status: "complete", path: outputPath, mime_type: encoding };
        } catch (err) {
          log.warn("media_generation_service.poll_uri_download_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
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

      log.warn("media_generation_service.poll_parse_failed", {
        error: "No video URI or bytesBase64Encoded in response",
        videoKeys: Object.keys(video),
      });
      return { status: "error", error: "No video URI or bytesBase64Encoded in video response" };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
