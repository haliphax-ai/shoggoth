# Specification

## Interfaces

### Configuration Schema

```ts
const mediaGenerationAdapterType = z.enum([
  "openai-images",
  "openai-chat-image",
  "openai-video-async",
  "openrouter-video",
  "gemini-generate-content",
  "gemini-predict",
  "gemini-long-running",
]);

const mediaGenerationModelEntry = z.object({
  /** Exact model name (what the agent passes as `model`). */
  name: z.string().min(1),
  /** Media type this model produces. */
  mediaType: z.enum(["image", "video", "audio"]),
  /** Per-model adapter override. Takes priority over provider defaultAdapter. */
  adapter: mediaGenerationAdapterType.optional(),
  /** Modalities to send in the request (for openai-chat-image). */
  modalities: z.array(z.string()).optional(),
});

const mediaGenerationProviderSchema = z.object({
  /** Unique identifier for this media provider. */
  id: z.string().min(1),
  /** Determines auth headers and URL construction. */
  kind: z.enum(["openai-compatible", "gemini"]),
  /** Base URL for API requests. */
  baseUrl: z.string().url(),
  /** API key (plaintext or env var reference). */
  apiKey: z.string().optional(),
  /** Environment variable name containing the API key. */
  apiKeyEnv: z.string().optional(),
  /** Gemini-specific: API version path segment. Default "v1beta". */
  apiVersion: z.string().optional(),
  /** Default adapter for all models in this provider (unless overridden per-model). */
  defaultAdapter: mediaGenerationAdapterType.optional(),
  /** Models available through this provider. */
  models: z.array(mediaGenerationModelEntry).min(1),
});

const mediaGenerationAdapterDefaults = z.object({
  /** Polling interval for async adapters. */
  pollIntervalMs: z.number().int().positive().optional(),
  /** Max time to poll before returning in_progress. */
  timeoutMs: z.number().int().positive().optional(),
});

const mediaGenerationConfigSchema = z.object({
  /** Media generation providers (independent from LLM providers). */
  providers: z.array(mediaGenerationProviderSchema).min(1),
  /** Per-adapter-type default settings. */
  adapterDefaults: z.record(mediaGenerationAdapterType, mediaGenerationAdapterDefaults).optional(),
  /** Directory for generated media files. Default: "{workspacePath}/tmp/media". */
  outputDirectory: z.string().min(1).optional(),
});
```

Added to the top-level config schema as:

```ts
mediaGeneration: mediaGenerationConfigSchema.optional(),
```

### Adapter Request/Response Types

```ts
/** Resolved provider info passed to adapters. */
interface ResolvedMediaProvider {
  id: string;
  kind: "openai-compatible" | "gemini";
  baseUrl: string;
  apiKey: string;
  apiVersion?: string; // gemini only
}

/** Common adapter request. */
interface MediaAdapterRequest {
  model: string;
  prompt: string;
  provider: ResolvedMediaProvider;
  outputPath: string;
  params: MediaGenerateParams;
  adapterDefaults?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
  };
}

/** Unchanged from current implementation. */
type MediaAdapterResult =
  | { status: "complete"; path: string; mime_type: string }
  | { status: "in_progress"; operation_id: string }
  | { status: "error"; error: string };
```

### Media Generation Service

```ts
interface MediaGenerationServiceConfig {
  providers: MediaProviderConfig[]; // providers with nested models
  adapterDefaults?: Record<string, { pollIntervalMs?: number; timeoutMs?: number }>;
}

interface MediaProviderConfig {
  id: string;
  kind: "openai-compatible" | "gemini";
  baseUrl: string;
  apiKey: string;
  apiVersion?: string;
  defaultAdapter?: string;
  models: { name: string; mediaType: string; adapter?: string; modalities?: string[] }[];
}

interface MediaGenerateRequest {
  model: string;
  prompt: string;
  params: MediaGenerateParams;
  output_path: string;
  timeout_ms?: number;
}

interface MediaPollRequest {

interface MediaGenerateRequest {
  model: string;
  prompt: string;
  params: MediaGenerateParams;
  output_path: string;
  timeout_ms?: number;
}

interface MediaPollRequest {
  model: string; // needed to resolve provider
  operation_id: string;
  output_path?: string;
}

class MediaGenerationService {
  constructor(config: MediaGenerationServiceConfig);

  /** Resolve model → provider + adapter, then dispatch. */
  generate(req: MediaGenerateRequest): Promise<MediaAdapterResult>;

  /** Poll an async operation. */
  poll(req: MediaPollRequest): Promise<MediaAdapterResult>;
}
```

### Model Resolution

```ts
interface ResolvedModel {
  provider: ResolvedMediaProvider;
  adapter: string;
  modalities?: string[];
}

/**
 * Resolve a model name by searching all providers' model lists for an exact name match.
 * First provider with a matching model entry wins.
 *
 * Adapter resolution order:
 * 1. model.adapter (per-model override)
 * 2. provider.defaultAdapter
 * 3. ADAPTER_DEFAULTS[provider.kind][model.mediaType] (built-in fallback)
 */
function resolveModel(model: string, providers: MediaProviderConfig[]): ResolvedModel | undefined;
```

No glob patterns. No implicit matching. Exact model name lookup only.

### OpenAI Images Adapter

```ts
/**
 * POST {baseUrl}/images/generations
 *
 * Request body:
 * {
 *   "model": "black-forest-labs/flux.2-pro",
 *   "prompt": "A cabin at sunset",
 *   "n": 1,
 *   "size": "1024x1024",        // derived from aspectRatio
 *   "response_format": "b64_json"
 * }
 *
 * Response:
 * {
 *   "data": [
 *     { "b64_json": "..." }     // base64-encoded image
 *     // OR
 *     { "url": "https://..." }  // temporary URL to download
 *   ]
 * }
 */
async function openaiImagesAdapter(req: MediaAdapterRequest): Promise<MediaAdapterResult>;
```

### OpenAI Chat Image Adapter

```ts
/**
 * POST {baseUrl}/chat/completions
 *
 * Request body:
 * {
 *   "model": "openai/gpt-5-image",
 *   "messages": [{ "role": "user", "content": "Generate an image of..." }],
 *   "modalities": ["text", "image"]
 * }
 *
 * Response: standard chat completion with image content parts:
 * {
 *   "choices": [{
 *     "message": {
 *       "content": [
 *         { "type": "text", "text": "Here's your image" },
 *         { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
 *       ]
 *     }
 *   }]
 * }
 */
async function openaiChatImageAdapter(req: MediaAdapterRequest): Promise<MediaAdapterResult>;
```

### OpenAI Video Async Adapter (legacy)

```ts
/**
 * Submit: POST {baseUrl}/chat/completions
 * {
 *   "model": "minimax/hailuo-2.3",
 *   "messages": [{ "role": "user", "content": "A drone shot..." }]
 * }
 *
 * Response includes generation_id header or body field.
 *
 * Poll: GET {baseUrl}/generation?id={generation_id}
 * Response:
 * {
 *   "status": "complete",
 *   "video_url": "https://..."
 * }
 * OR
 * {
 *   "status": "pending"
 * }
 */
async function openaiVideoAsyncAdapter(req: MediaAdapterRequest): Promise<MediaAdapterResult>;
```

### OpenRouter Video Adapter

```ts
/**
 * OpenRouter's dedicated video generation API.
 * Completely separate from chat/completions — uses /videos endpoint.
 *
 * Submit: POST {baseUrl}/videos
 * {
 *   "model": "google/veo-3.1",
 *   "prompt": "A drone shot over a tropical island",
 *   "duration": 8,              // from params.durationSeconds
 *   "resolution": "1080p",      // derived from params or default
 *   "aspect_ratio": "16:9",     // from params.aspectRatio
 *   "frame_images": [...]       // from params.input_image (mapped to first_frame)
 * }
 *
 * Submit Response (202):
 * {
 *   "id": "abc123",
 *   "polling_url": "https://openrouter.ai/api/v1/videos/abc123",
 *   "status": "pending"
 * }
 *
 * Poll: GET {polling_url}
 * Response:
 * {
 *   "id": "abc123",
 *   "status": "completed",       // "pending" | "in_progress" | "completed" | "failed"
 *   "unsigned_urls": ["https://openrouter.ai/api/v1/videos/abc123/content?index=0"],
 *   "usage": { "cost": 0.25 }
 * }
 *
 * Download: GET unsigned_urls[0]
 * Returns raw video bytes (video/mp4).
 */
async function openrouterVideoAdapter(req: MediaAdapterRequest): Promise<MediaAdapterResult>;
```

### Existing Gemini Adapters

Signatures unchanged. The `MediaAdapterRequest` interface gains a `provider` field instead of flat `apiKey`/`baseUrl` — adapters extract what they need from it.

### Example Configuration

```jsonc
{
  "mediaGeneration": {
    "providers": [
      {
        "id": "openrouter-images",
        "kind": "openai-compatible",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "defaultAdapter": "openai-images",
        "models": [
          { "name": "black-forest-labs/flux.2-pro", "mediaType": "image" },
          { "name": "black-forest-labs/flux.2-klein-4b", "mediaType": "image" },
          { "name": "recraft/recraft-v3", "mediaType": "image" },
          { "name": "bytedance-seed/seedream-3.0", "mediaType": "image" },
          // Chat-image models override the provider default
          {
            "name": "openai/gpt-5-image",
            "mediaType": "image",
            "adapter": "openai-chat-image",
            "modalities": ["text", "image"],
          },
          {
            "name": "openai/gpt-5-image-mini",
            "mediaType": "image",
            "adapter": "openai-chat-image",
            "modalities": ["text", "image"],
          },
        ],
      },
      {
        "id": "openrouter-video",
        "kind": "openai-compatible",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "defaultAdapter": "openrouter-video",
        "models": [
          { "name": "google/veo-3.1", "mediaType": "video" },
          { "name": "google/veo-3.1-fast", "mediaType": "video" },
          { "name": "google/veo-3.1-lite", "mediaType": "video" },
          { "name": "minimax/hailuo-2.3", "mediaType": "video" },
          { "name": "kwaivgi/kling-v3.0-pro", "mediaType": "video" },
          { "name": "kwaivgi/kling-v3.0-std", "mediaType": "video" },
          { "name": "openai/sora-2-pro", "mediaType": "video" },
          { "name": "bytedance/seedance-2.0", "mediaType": "video" },
          { "name": "alibaba/wan-2.7", "mediaType": "video" },
        ],
      },
      {
        "id": "gemini",
        "kind": "gemini",
        "baseUrl": "https://generativelanguage.googleapis.com",
        "apiKeyEnv": "GEMINI_API_KEY",
        "models": [
          { "name": "gemini-2.5-flash-preview-image", "mediaType": "image" },
          { "name": "gemini-3-pro-image-preview", "mediaType": "image" },
          { "name": "gemini-2.5-flash-preview-tts", "mediaType": "audio" },
          { "name": "lyria-3-pro-preview", "mediaType": "audio" },
          { "name": "imagen-3.0-generate-002", "mediaType": "image", "adapter": "gemini-predict" },
          { "name": "veo-3.1-generate-preview", "mediaType": "video" },
        ],
      },
    ],
    "adapterDefaults": {
      "openai-video-async": {
        "pollIntervalMs": 5000,
        "timeoutMs": 300000,
      },
      "openrouter-video": {
        "pollIntervalMs": 30000,
        "timeoutMs": 300000,
      },
      "gemini-long-running": {
        "pollIntervalMs": 10000,
        "timeoutMs": 300000,
      },
    },
  },
}
```

````

### Control Plane Payload (unchanged shape, new routing)

```ts
// media_generate request — same interface as before
interface MediaGeneratePayload {
  model: string;
  prompt: string;
  params: MediaGenerateParams;
  output_path?: string;
  timeout_ms?: number;
}

// provider_id is NO LONGER in the payload.
// The service resolves it from config based on exact model name match.

### Builtin Tool Schema (updated)

```json
{
  "name": "builtin-media-generate",
  "description": "Generate images, audio, video, or music using configured media generation models",
  "parameters": {
    "type": "object",
    "properties": {
      "model": {
        "type": "string",
        "description": "Model identifier (e.g. black-forest-labs/flux.2-pro, minimax/hailuo-2.3, gemini-2.5-flash-image)"
      },
      "prompt": { "type": "string", "description": "Generation prompt" },
      "params": {
        "type": "object",
        "description": "Parameters discriminated by 'kind': image (aspectRatio), video (aspectRatio, durationSeconds), speech (voice), music (durationSeconds)",
        "required": ["kind"]
      },
      "output_path": {
        "type": "string",
        "description": "Workspace-relative output path. Auto-generated if omitted."
      },
      "show": {
        "type": "boolean",
        "description": "Surface the result to the user via builtin-show. Default true (images only)."
      },
      "timeout_ms": {
        "type": "number",
        "description": "Max poll time for async models before returning in_progress status."
      }
    },
    "required": ["model", "prompt", "params"]
  }
}
````

## Code Examples

### Model Resolution

```ts
const config: MediaGenerationServiceConfig = {
  providers: [
    {
      id: "openrouter-images",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-...",
      defaultAdapter: "openai-images",
      models: [{ name: "black-forest-labs/flux.2-pro", mediaType: "image" }],
    },
    {
      id: "openrouter-video",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-...",
      defaultAdapter: "openrouter-video",
      models: [
        { name: "minimax/hailuo-2.3", mediaType: "video" },
        { name: "google/veo-3.1", mediaType: "video" },
      ],
    },
  ],
};

const service = new MediaGenerationService(config);

// Image generation — resolves to openai-images adapter (provider default)
const result = await service.generate({
  model: "black-forest-labs/flux.2-pro",
  prompt: "A cabin at sunset in watercolor style",
  params: { kind: "image", aspectRatio: "16:9" },
  output_path: "/workspace/tmp/media/cabin.png",
});
// → { status: "complete", path: "/workspace/tmp/media/cabin.png", mime_type: "image/png" }

// Video generation — resolves to openrouter-video adapter (provider default)
const videoResult = await service.generate({
  model: "google/veo-3.1",
  prompt: "Drone shot over a tropical island at golden hour",
  params: { kind: "video", durationSeconds: 8, aspectRatio: "16:9" },
  output_path: "/workspace/tmp/media/island.mp4",
});
// → { status: "in_progress", operation_id: "abc123" }
// OR after polling completes:
// → { status: "complete", path: "/workspace/tmp/media/island.mp4", mime_type: "video/mp4" }
```

### Auth Header Construction

```ts
function buildAuthHeaders(provider: ResolvedMediaProvider): Record<string, string> {
  switch (provider.kind) {
    case "openai-compatible":
      return { Authorization: `Bearer ${provider.apiKey}` };
    case "gemini":
      return { "x-goog-api-key": provider.apiKey };
  }
}
```
