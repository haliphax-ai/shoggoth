# Implementation

## Phase 1: Config Schema and Model Resolution

Establish the new configuration schema and the model resolution logic that routes a model name to a provider + adapter.

- Define `mediaGenerationConfigSchema` in the shared schema package (providers with nested models, no top-level models array)
- Remove the old `mediaGeneration` schema fields (`defaultProviderId`, `modelAdapterMap`)
- Implement `resolveModel()` function — exact name match across all providers' model lists (first match wins)
- Adapter resolution: per-model `adapter` override → provider `defaultAdapter` → built-in kind+mediaType fallback
- Implement `resolveMediaProvider()` to extract apiKey (from field or env var)
- Unit tests for exact name resolution and adapter precedence

**Files:**

- `packages/shared/src/schema.ts` (replace `mediaGeneration` schema)
- `packages/daemon/src/media/resolve-model.ts` (new)
- `packages/daemon/src/media/resolve-model.test.ts` (new)

## Phase 2: Refactor MediaGenerationService

Rewrite the service to use config-driven routing instead of the hardcoded adapter map. The service becomes a thin dispatcher: resolve model → build adapter request → call adapter.

- Remove `BUILTIN_MODEL_ADAPTER_MAP`
- Remove `kind === "gemini"` checks
- Accept `MediaGenerationServiceConfig` (providers with nested models + adapterDefaults)
- Dispatch to adapter based on resolved `adapter` type (including new `openrouter-video`)
- Update `MediaAdapterRequest` to carry `ResolvedMediaProvider` instead of flat `apiKey`/`baseUrl`
- Refactor existing Gemini adapters to accept the new request shape
- Unit tests for service dispatch logic

**Files:**

- `packages/daemon/src/media/media-generation-service.ts` (rewrite)
- `packages/daemon/src/media/adapters/types.ts` (update `MediaAdapterRequest`)
- `packages/daemon/src/media/adapters/generate-content-adapter.ts` (update signature)
- `packages/daemon/src/media/adapters/predict-adapter.ts` (update signature)
- `packages/daemon/src/media/adapters/long-running-adapter.ts` (update signature)
- `packages/daemon/test/media/media-generation-service.test.ts` (rewrite)

## Phase 3: OpenAI Images Adapter

Implement the synchronous `/images/generations` adapter for dedicated image generation models (FLUX, Recraft, Seedream, Riverflow).

- Build request body (`model`, `prompt`, `n`, `size`, `response_format`)
- Map `aspectRatio` param to `size` string (e.g. `"16:9"` → `"1792x1024"`)
- Handle response: `b64_json` (decode + write) or `url` (download + write)
- Auth via `Authorization: Bearer`
- Unit tests with mocked fetch

**Files:**

- `packages/daemon/src/media/adapters/openai-images-adapter.ts` (new)
- `packages/daemon/test/media/openai-images-adapter.test.ts` (new)

## Phase 4: OpenAI Chat Image Adapter

Implement the chat-completions adapter for models that output images inline (GPT-5 Image family via OpenRouter).

- Build chat completions request with `modalities: ["text", "image"]`
- Parse response: extract image content parts (data URI or `image_url`)
- Decode base64 from data URI, write to file
- Handle case where model returns text-only (no image generated) — return error
- Unit tests with mocked fetch

**Files:**

- `packages/daemon/src/media/adapters/openai-chat-image-adapter.ts` (new)
- `packages/daemon/test/media/openai-chat-image-adapter.test.ts` (new)

## Phase 5: OpenAI Video Async Adapter

Implement the async video generation adapter with polling (legacy protocol for non-OpenRouter providers).

- Submit generation request via chat completions
- Extract `generation_id` from response header (`X-Generation-Id`) or body
- Poll `GET {baseUrl}/generation?id={generation_id}` at configured interval
- On completion: download video from URL, write to file
- On timeout: return `in_progress` with `operation_id` for later polling
- Stream download for large video files (pipe response body to file)
- Unit tests with mocked fetch (submit + poll sequence)

**Files:**

- `packages/daemon/src/media/adapters/openai-video-async-adapter.ts` (new)
- `packages/daemon/test/media/openai-video-async-adapter.test.ts` (new)

## Phase 5b: OpenRouter Video Adapter

Implement the dedicated OpenRouter video generation adapter. OpenRouter uses a completely separate `/videos` endpoint (not chat/completions) with an async polling workflow.

**Protocol:**

- Submit: `POST {baseUrl}/videos` with `{ model, prompt, duration?, resolution?, aspect_ratio?, frame_images?, generate_audio? }`
- Response: `{ id, polling_url, status: "pending" }`
- Poll: `GET {polling_url}` (URL returned in submit response)
- Poll response: `{ id, status, unsigned_urls?, usage?, error? }`
- Status values: `"pending"` | `"in_progress"` | `"completed"` | `"failed"`
- Download: `GET unsigned_urls[0]` returns raw video bytes

**Implementation details:**

- Map `params.durationSeconds` → `duration`
- Map `params.aspectRatio` → `aspect_ratio`
- Map `params.input_image` → `frame_images` array with `frame_type: "first_frame"`
- Map `params.last_frame` → `frame_images` array entry with `frame_type: "last_frame"`
- Use `polling_url` from submit response (don't construct poll URL manually)
- Poll at 30s intervals (OpenRouter docs recommend this for video)
- On `"completed"`: download from `unsigned_urls[0]`, write to file
- On `"failed"`: return error with message from `error` field
- On timeout: return `in_progress` with job `id` as `operation_id`
- Auth: `Authorization: Bearer {apiKey}` on all requests (submit + poll + download)
- Unit tests with mocked fetch (submit → poll pending → poll completed → download)

**Files:**

- `packages/daemon/src/media/adapters/openrouter-video-adapter.ts` (new)
- `packages/daemon/test/media/openrouter-video-adapter.test.ts` (new)

## Phase 6: Control Plane and Tool Injection

Update the control plane op and tool injection to use the new config-driven system.

- Remove `kind === "gemini"` validation from `media_generate` op in `integration-ops.ts`
- Remove `provider_id` from the control op payload (resolved internally)
- Construct `MediaGenerationService` from `config.mediaGeneration`
- Update `media_generate_poll` to resolve provider from model name
- Update `createMediaGenerateToolFinalizer` to check for any configured media provider/model
- Update `builtin-media-generate` handler to remove `resolveProviderId` (no longer needed)
- Integration tests for the control op with new routing

**Files:**

- `packages/daemon/src/control/integration-ops.ts` (update)
- `packages/daemon/src/sessions/session-mcp-tool-context.ts` (update finalizer)
- `packages/daemon/src/sessions/builtin-handlers/media-generate-handler.ts` (update)
- `packages/daemon/test/media/media-generate-control-op.test.ts` (update)

## Phase 7: CLI Update

Update the CLI `shoggoth media generate` command to work without `--provider` (resolved from config).

- Remove required `--provider` flag (keep as optional override for debugging)
- If `--provider` is given, validate it exists in `mediaGeneration.providers`
- Update help text and examples
- Update CLI tests

**Files:**

- `packages/cli/src/run-media.ts` (update)
- `packages/cli/test/run-media.test.ts` (update)

## Phase 8: Skill Documentation

Update the media generation skill file to document the full model catalog and new configuration.

- List available adapter types and their use cases
- Provide example invocations for each adapter type
- Document which models are available through OpenRouter vs direct Gemini

**Files:**

- `skills/media-generate.md` (rewrite)
