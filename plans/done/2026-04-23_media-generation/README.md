---
date: 2026-04-23
completed: 2026-04-23
---

# Media Generation via Control Plane

## Summary

Expose Google's non-text generation models (image, video, audio, music) as control plane operations, builtin tools, CLI commands, and slash commands — without modifying the chat completion provider layer.

## Motivation

Google's Gemini API now offers image generation (Nano Banana, Imagen 4), video generation (Veo 3.1/2.0), text-to-speech (Gemini Flash TTS), and music generation (Lyria 3 Pro/Clip) alongside the text/reasoning models Shoggoth already supports. These models use different API patterns than `generateContent` chat flow, and exposing them through the chat provider would conflate "reasoning" with "media creation." Instead, media generation should be a deliberate tool action — agents invoke it when needed, results are delivered as files via `builtin-show` or platform attachments.

## Design

### Architecture

```
Agent/Operator
    │
    ├─ builtin-media-generate (tool)
    ├─ shoggoth media generate (CLI)
    ├─ /generate (slash command)
    │
    ▼
control plane op: media_generate
    │
    ▼
MediaGenerationService
    ├─ GeminiGenerateContentAdapter  (Nano Banana, TTS, Lyria 3)
    ├─ GeminiPredictAdapter          (Imagen 4)
    └─ GeminiLongRunningAdapter      (Veo 3.1/2.0)
    │
    ▼
Result: file written to workspace or inboundMediaRoot
    │
    ▼
Surfaced via builtin-show / platform attachment
```

### Control Plane Operation

New op: `media_generate`

Request payload:

```ts
interface MediaGeneratePayload {
  /** Model identifier, e.g. "nano-banana-pro", "imagen-4.0-generate-preview-06-2025", "veo-3.1-generate-preview", "lyria-3-pro-preview", "gemini-2.5-flash-preview-tts" */
  model: string;
  /** Text prompt for generation */
  prompt: string;
  /** Provider ID from models.providers config (must be kind: "gemini") */
  provider_id: string;
  /** Model-specific parameters, discriminated by `kind` */
  params: ImageGenerateParams | VideoGenerateParams | SpeechGenerateParams | MusicGenerateParams;
  /** Where to write the output file. Workspace-relative path. Auto-generated if omitted. */
  output_path?: string;
  /** For async models (Veo): max poll time in ms before returning in-progress status. Default 300000 (5 min). */
  timeout_ms?: number;
}

interface ImageGenerateParams {
  kind: "image";
  aspectRatio?: string;
  numberOfImages?: number;
  /** Workspace-relative path to an input image for editing. */
  input_image?: string;
}

interface VideoGenerateParams {
  kind: "video";
  aspectRatio?: string;
  /** Duration in seconds */
  durationSeconds?: number;
  /** Workspace-relative path to a reference image for image-to-video. */
  input_image?: string;
}

interface SpeechGenerateParams {
  kind: "speech";
  /** Voice name for TTS (e.g. "Kore", "Puck") */
  voice?: string;
}

interface MusicGenerateParams {
  kind: "music";
  /** Duration hint in seconds */
  durationSeconds?: number;
}
```

Response:

```ts
type MediaGenerateResult = MediaGenerateComplete | MediaGenerateInProgress | MediaGenerateError;

interface MediaGenerateComplete {
  status: "complete";
  /** Absolute path to the generated file */
  path: string;
  /** MIME type of the output */
  mime_type: string;
}

interface MediaGenerateInProgress {
  status: "in_progress";
  /** Operation ID for polling via media_generate_poll */
  operation_id: string;
}

interface MediaGenerateError {
  status: "error";
  error: string;
}
```

For Veo (async), a second op `media_generate_poll` checks status:

```ts
interface MediaGeneratePollPayload {
  provider_id: string;
  operation_id: string;
  output_path?: string;
}
```

### MediaGenerationService

New module: `packages/daemon/src/media/media-generation-service.ts`

Responsible for:

- Resolving the provider config (must be `kind: "gemini"`) and extracting API key / base URL
- Routing to the correct adapter based on model name
- Writing output files to the agent's workspace (or `inboundMediaRoot` for shared access)
- Returning structured results

### Adapters

#### GeminiGenerateContentAdapter

For models that use the standard `generateContent` endpoint with `responseModalities`:

- Nano Banana / Nano Banana Pro: `responseModalities: ["IMAGE"]` (or `["TEXT", "IMAGE"]`)
- Gemini Flash TTS: `responseModalities: ["AUDIO"]` + `speechConfig`
- Lyria 3 Pro / Clip: `responseModalities: ["AUDIO"]`

Request: Standard `generateContent` POST with `generationConfig.responseModalities` set. When `input_image` is provided, the image is read from disk, base64-encoded, and included as an `inlineData` part in the user message (same format the chat provider uses for image understanding).
Response: Parse `inlineData` parts from candidates, base64-decode, write to file.

```ts
interface GenerateContentMediaRequest {
  model: string;
  prompt: string;
  responseModalities: string[];
  speechConfig?: {
    voiceConfig?: { prebuiltVoiceConfig?: { voiceName: string } };
  };
  generationConfig?: Record<string, unknown>;
}
```

#### GeminiPredictAdapter

For Imagen 4 which uses the Vertex-style `predict` endpoint:

```
POST /v1beta/models/{model}:predict
{
  "instances": [{ "prompt": "..." }],
  "parameters": {
    "sampleCount": 1,
    "aspectRatio": "1:1",
    ...
  }
}
```

When `input_image` is provided, the image bytes are included as `instances[].image.bytesBase64Encoded` for editing workflows.

Response: `predictions[].bytesBase64Encoded` → decode and write.

#### GeminiLongRunningAdapter

For Veo which uses async operations:

```
POST /v1beta/models/{model}:predictLongRunning
{
  "instances": [{ "prompt": "..." }],
  "parameters": { "aspectRatio": "16:9", "durationSeconds": 8 }
}
→ { "name": "operations/...", "done": false }

GET /v1beta/{name}
→ { "done": true, "response": { "generateVideoResponse": { "generatedSamples": [...] } } }
```

When `input_image` is provided, the image is included as a reference frame in the instances payload for image-to-video generation.

The adapter polls internally up to `timeout_ms`, then returns either the completed result or an `in_progress` status with the `operation_id` for the caller to poll later via `media_generate_poll`.

### Model Routing

A built-in lookup table maps model names to adapters. At runtime, the operator-configured `modelAdapterMap` from the `mediaGeneration` config section is merged on top (`{ ...BUILTIN_MAP, ...config.modelAdapterMap }`), so config values take precedence and new models can be added without a code change.

Built-in defaults:

```ts
const BUILTIN_MODEL_ADAPTER_MAP: Record<string, "generateContent" | "predict" | "longRunning"> = {
  "nano-banana": "generateContent",
  "gemini-2.5-flash-preview-tts": "generateContent",
  "gemini-2.5-pro-preview-tts": "generateContent",
  "gemini-3.1-flash-tts": "generateContent",
  "lyria-3": "generateContent",
  imagen: "predict",
  veo: "longRunning",
};
```

Operator overrides in config (spread on top of built-ins, config wins):

```json
{
  "mediaGeneration": {
    "modelAdapterMap": {
      "my-custom-image-model": "generateContent",
      "some-new-video-model": "longRunning"
    }
  }
}
```

Resolution: exact key match against the merged map. If no match, the op returns an error.

### Builtin Tool

New builtin handler: `builtin-media-generate`

Schema exposed to agents:

```json
{
  "name": "builtin-media-generate",
  "description": "Generate images, audio, video, or music using Google AI models",
  "parameters": {
    "type": "object",
    "properties": {
      "model": {
        "type": "string",
        "description": "Model name (e.g. nano-banana-pro, imagen-4.0-generate-preview-06-2025, veo-3.1-generate-preview, lyria-3-pro-preview)"
      },
      "prompt": { "type": "string", "description": "Generation prompt" },
      "params": {
        "type": "object",
        "description": "Parameters discriminated by 'kind': image (aspectRatio, numberOfImages), video (aspectRatio, durationSeconds), speech (voice), music (durationSeconds)",
        "required": ["kind"]
      },
      "output_path": {
        "type": "string",
        "description": "Workspace-relative output path. Auto-generated if omitted."
      },
      "show": {
        "type": "boolean",
        "description": "When true, surface the result to the user via builtin-show. Default true."
      }
    },
    "required": ["model", "prompt", "params"]
  }
}
```

The handler:

1. Resolves `provider_id` from config (first `gemini` provider, or a new `mediaGeneration.defaultProviderId` config field)
2. Invokes the `media_generate` control op
3. If `show` is true (default), calls `builtin-show` internally to surface the result to the user
4. Returns the file path and metadata regardless of `show` — the agent can use the file for further processing

### CLI

```
shoggoth media generate --model <model> --prompt <prompt> [--provider <id>] [--output <path>] [--param key=value...]
shoggoth media poll --provider <id> --operation <id> [--output <path>]
shoggoth media models    # list available media generation models
```

### Slash Command (Discord)

`/generate` with options:

- `model` (required, autocomplete from known model list)
- `prompt` (required)
- `params` (optional, JSON string)

The slash command handler invokes the control op and posts the result as a Discord attachment (image/audio/video file).

### Config

New optional top-level config section:

```ts
const shoggothMediaGenerationConfigSchema = z
  .object({
    /** Default provider ID for media generation (must be kind: "gemini"). Resolved from first gemini provider if omitted. */
    defaultProviderId: z.string().min(1).optional(),
    /** Directory for generated media files. Default: "{workspacesRoot}/{agentId}/tmp/media" */
    outputDirectory: z.string().min(1).optional(),
    /** Max poll time for async models (Veo). Default 300000 (5 min). */
    defaultTimeoutMs: z.number().int().positive().optional(),
    /** Operator-defined model-to-adapter mappings, merged on top of built-in defaults. Values must be one of "generateContent", "predict", or "longRunning". */
    modelAdapterMap: z
      .record(z.string(), z.enum(["generateContent", "predict", "longRunning"]))
      .optional(),
  })
  .strict();
```

Added to `shoggothConfigSchema` and `shoggothConfigFragmentSchema` as `mediaGeneration?: ...`.

### HITL Risk

`builtin-media-generate` should default to `caution` tier — it makes external API calls and writes files, but doesn't execute arbitrary code.

### Policy

`media_generate` and `media_generate_poll` added to the default agent control ops allow list.

## Implementation Phases

### Phase 1: Core service and generateContent adapter

Build the media generation service with the `generateContent` adapter (Nano Banana, TTS, Lyria 3). This covers the most models with the simplest API pattern.

- Media generation service with adapter routing
- `generateContent` adapter handling `responseModalities` and `inlineData` parsing
- File output (base64 decode → write)
- Unit tests for adapter and service

**Files:**

- `packages/daemon/src/media/media-generation-service.ts` (new)
- `packages/daemon/src/media/adapters/generate-content-adapter.ts` (new)
- `packages/daemon/src/media/adapters/types.ts` (new)
- `packages/daemon/test/media/generate-content-adapter.test.ts` (new)
- `packages/daemon/test/media/media-generation-service.test.ts` (new)

### Phase 2: Control plane op and builtin tool

Wire the service into the control plane and expose as a builtin tool.

- `media_generate` control op in `integration-ops.ts`
- `builtin-media-generate` handler
- Config schema additions
- Policy / HITL defaults
- Integration tests

**Files:**

- `packages/daemon/src/control/integration-ops.ts` (extend)
- `packages/daemon/src/sessions/builtin-handlers.ts` (extend) or new `media-generate-handler.ts`
- `packages/shared/src/schema.ts` (extend)
- `packages/daemon/src/policy/engine.ts` (add op to known list)
- `packages/daemon/test/media/media-generate-control-op.test.ts` (new)

### Phase 3: Predict adapter (Imagen 4)

Add the `predict` endpoint adapter for Imagen.

- Request/response mapping for Imagen's `predict` format
- Unit tests

**Files:**

- `packages/daemon/src/media/adapters/predict-adapter.ts` (new)
- `packages/daemon/test/media/predict-adapter.test.ts` (new)

### Phase 4: Long-running adapter (Veo)

Add the async polling adapter for Veo and the `media_generate_poll` control op.

- `predictLongRunning` request + polling loop
- `media_generate_poll` control op
- Timeout handling

**Files:**

- `packages/daemon/src/media/adapters/long-running-adapter.ts` (new)
- `packages/daemon/src/control/integration-ops.ts` (extend with poll op)
- `packages/daemon/test/media/long-running-adapter.test.ts` (new)

### Phase 5: CLI and slash command

Add the CLI subcommand and Discord slash command.

- `shoggoth media` CLI subcommand
- Discord `/generate` slash command (in platform-discord plugin)

**Files:**

- `packages/cli/src/run-media.ts` (new)
- `packages/cli/src/cli.ts` (extend)
- `packages/platform-discord/src/slash-commands.ts` (extend) or new file

## Testing Strategy

- Unit tests for each adapter with mocked fetch (verify request shape, response parsing, file writing)
- Unit tests for model routing logic
- Integration tests for the control op (mock service, verify payload validation and error handling)
- Integration test for the builtin tool handler
- Manual verification: generate an image with Nano Banana, TTS audio, and a Lyria clip through the CLI

## Considerations

- **Lyria RealTime** is intentionally excluded — it requires WebSocket (Live API) infrastructure that doesn't exist in Shoggoth. Could be revisited if Live API support is added.
- **Rate limits** for media generation models are much lower than text models. The service should surface rate limit errors clearly rather than retrying aggressively.
- **Cost** — media generation is significantly more expensive per call than text. The `caution` HITL tier provides a gate, but operators may want to set it to `critical` for cost control.
- **File cleanup** — generated media files should be subject to the existing retention system (`inboundMediaMaxAgeDays`). The output directory should be under `inboundMediaRoot` or the agent's workspace `tmp/`.
- **Streaming** — Nano Banana and TTS support streaming responses, but for simplicity this plan uses non-streaming requests. Streaming could be added later for progress feedback on large generations.
- **Image/video input** — `input_image` is supported on `image` and `video` param types. The existing `image-ingest.ts` MIME detection (magic byte sniffing) and `geminiImageBlockCodec` are reused for encoding. Files are read from the agent's workspace or `inboundMediaRoot`.

## Migration

No data migration needed. New config section `mediaGeneration` is optional with sensible defaults. New control ops are additive. The `builtin-media-generate` tool is opt-in via tool discovery.
