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
import { openrouterVideoAdapter } from "./adapters/openrouter-video-adapter";
import type {
  MediaAdapterRequest,
  MediaAdapterResult,
  MediaGenerateParams,
} from "./adapters/types";
import { resolveModel, type MediaProviderConfig } from "./resolve-model.js";
import {
  resolveMediaDefaultModel,
  type ShoggothMediaGenerationDefaults,
} from "./media-defaults.js";
import {
  mediaGenerationModelEntriesFromRecord,
  mediaGenerationProvidersToEntries,
  type ShoggothMediaGenerationConfig,
} from "@shoggoth/shared";

export type MediaAdapterFn = (req: MediaAdapterRequest) => Promise<MediaAdapterResult>;

/** Adapter registry keyed by adapter name (see resolve-model MediaProviderConfig.adapter). */
export interface MediaAdapterRegistry {
  "gemini-generate-content": MediaAdapterFn;
  "gemini-predict": MediaAdapterFn;
  "gemini-long-running": MediaAdapterFn;
  "openai-images": MediaAdapterFn;
  "openai-chat-image": MediaAdapterFn;
  "openai-video-async": MediaAdapterFn;
  "openrouter-video": MediaAdapterFn;
}

const defaultAdapters: MediaAdapterRegistry = {
  "gemini-generate-content": (req) => generateContentAdapter(req),
  "gemini-predict": (req) => predictAdapter(req),
  "gemini-long-running": (req) =>
    longRunningAdapter(req as MediaAdapterRequest & { timeout_ms?: number }),
  "openai-images": (req) => openAIImagesAdapter(req),
  "openai-chat-image": (req) => openAIChatImageAdapter(req),
  "openai-video-async": (req) => openaiVideoAsyncAdapter(req),
  "openrouter-video": (req) => openrouterVideoAdapter(req),
};

export interface PollRequest {
  provider_id: string;
  operation_id: string;
  output_path?: string;
}

interface GenerateRequest {
  /** Omitted when the caller relies on the configured media-type default. */
  model?: string;
  prompt: string;
  params: MediaGenerateParams;
  output_path: string;
  timeout_ms?: number;
}

export class MediaGenerationService {
  private readonly providers: MediaProviderConfig[];
  private readonly adapterDefaults?: Record<string, unknown>;
  private readonly adapters: MediaAdapterRegistry;
  private readonly defaults?: ShoggothMediaGenerationDefaults;

  constructor(config: {
    providers: MediaProviderConfig[];
    adapterDefaults?: Record<string, unknown>;
    adapters?: Partial<MediaAdapterRegistry>;
    defaults?: ShoggothMediaGenerationDefaults;
  }) {
    this.providers = config.providers;
    this.adapterDefaults = config.adapterDefaults;
    this.adapters = { ...defaultAdapters, ...config.adapters };
    this.defaults = config.defaults;
  }

  static fromConfig(
    config: ShoggothMediaGenerationConfig,
    adapters?: Partial<MediaAdapterRegistry>,
  ): MediaGenerationService {
    // Resolve providers from config, nesting models inside
    const resolvedProviders: MediaProviderConfig[] = mediaGenerationProvidersToEntries(
      config.providers,
    ).map((p) => ({
      id: p.id,
      kind: p.kind as "openai-compatible" | "gemini",
      baseUrl: p.baseUrl,
      apiKey: p.apiKey ?? (p.apiKeyEnv ? (process.env[p.apiKeyEnv] ?? "") : ""),
      apiVersion: p.apiVersion,
      models: mediaGenerationModelEntriesFromRecord(p.models).map((m) => ({
        name: m.name,
        mediaType: m.mediaType as "image" | "video" | "audio",
        adapter: m.adapter,
      })),
    }));

    return new MediaGenerationService({
      providers: resolvedProviders,
      adapterDefaults: config.adapterDefaults,
      defaults: config.defaults,
      ...(adapters ? { adapters } : {}),
    });
  }

  /**
   * Resolve a model reference to provider + adapter. References are strictly
   * `provider-id/model-id`, split on the FIRST slash — the model id itself
   * may contain slashes (e.g. `openrouter/black-forest-labs/flux.2-klein-4b`
   * or `openrouter/google/gemini-2.5-pro-preview-tts`). Bare model ids are
   * rejected: the provider prefix is Shoggoth's routing concern.
   */
  private resolveModelRef(ref: string): ReturnType<typeof resolveModel> {
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) return undefined;
    const provider = this.providers.find((p) => p.id === ref.slice(0, slash));
    if (!provider) return undefined;
    return resolveModel(ref.slice(slash + 1), [provider]);
  }

  async generate(req: GenerateRequest): Promise<MediaAdapterResult> {
    const model = req.model ?? resolveMediaDefaultModel(this.defaults, req.params.kind);
    if (!model) {
      return {
        status: "error",
        error: `model is required: no model given and no default model configured for media type "${req.params.kind}"`,
      };
    }

    const resolved = this.resolveModelRef(model);
    if (!resolved) {
      return {
        status: "error",
        error: `No provider/adapter found for model: ${model} (expected provider-id/model-id)`,
      };
    }

    const adapterName = resolved.adapter;
    // The wire format is the raw model name — the provider prefix is only
    // Shoggoth's routing concern.
    const slash = model.indexOf("/");
    const wireModel = slash > 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
    const adapterReq: MediaAdapterRequest = {
      model: wireModel,
      prompt: req.prompt,
      provider: resolved.provider,
      outputPath: req.output_path,
      params: req.params,
      ...(resolved.modalities ? { modalities: resolved.modalities } : {}),
    };

    const adapter = this.adapters[adapterName as keyof MediaAdapterRegistry];
    if (!adapter) {
      return {
        status: "error",
        error: `Unknown adapter: ${adapterName}`,
      };
    }
    return adapter(adapterReq);
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
