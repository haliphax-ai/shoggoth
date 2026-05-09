---
id: media-generate
title: Media Generation
description: Multi-provider media generation via builtin-media-generate tool — images, video, and audio through OpenRouter and Google Gemini
tags:
  [media, generation, image, video, audio, openrouter, gemini, flux, recraft, veo, imagen, lyria]
category: media
enabled: true
---

The `builtin-media-generate` tool provides unified access to multiple media generation providers through a pluggable adapter architecture. Provider routing is automatic — specify the model and the system resolves the correct provider and adapter from configuration.

---

## Tool Parameters

| Parameter     | Type    | Required | Description                                                   |
| ------------- | ------- | -------- | ------------------------------------------------------------- |
| `model`       | string  | yes      | Model identifier (must match a configured model name exactly) |
| `prompt`      | string  | yes      | Text prompt describing the desired output                     |
| `params`      | object  | yes      | Generation parameters — must include `kind`                   |
| `output_path` | string  | no       | Workspace-relative output path (auto-generated if omitted)    |
| `show`        | boolean | no       | Surface generated images inline (default: `true`)             |

### Params Object

| Field             | Kind        | Description                                           |
| ----------------- | ----------- | ----------------------------------------------------- |
| `kind`            | all         | Required. One of: `image`, `video`, `speech`, `music` |
| `aspectRatio`     | image/video | Aspect ratio (e.g., `16:9`, `1:1`, `9:16`)            |
| `numberOfImages`  | image       | Number of images to generate                          |
| `input_image`     | image/video | Base64-encoded input image for editing/i2v            |
| `last_frame`      | video       | Base64-encoded last frame (video only)                |
| `durationSeconds` | video/music | Duration in seconds                                   |
| `voice`           | speech      | Voice name for TTS                                    |

---

## Adapters

The system uses 4 adapter types, selected automatically based on provider kind and model media type:

| Adapter                   | Provider Kind     | Media Type | Description                             |
| ------------------------- | ----------------- | ---------- | --------------------------------------- |
| `openai-chat-image`       | openai-compatible | image      | Chat completions with image modalities  |
| `openai-video-async`      | openai-compatible | video      | Async video generation with polling     |
| `gemini-generate-content` | gemini            | image      | Gemini generateContent for image models |
| `gemini-long-running`     | gemini            | video      | Gemini long-running operations (Veo)    |
| `gemini-predict`          | gemini            | image      | Vertex-style predict endpoint (Imagen)  |

Per-model adapter overrides are supported in config for special cases (e.g., Imagen uses `gemini-predict` instead of the default `gemini-generate-content`).

---

## Available Models

### Google (Direct Gemini API)

| Model                            | Kind  | Description                                  |
| -------------------------------- | ----- | -------------------------------------------- |
| `gemini-2.5-flash-preview-image` | image | Gemini 2.5 Flash — fast multimodal image gen |
| `gemini-3-pro-image-preview`     | image | Gemini 3 Pro — high-quality image generation |
| `gemini-3.1-flash-image-preview` | image | Gemini 3.1 Flash — latest fast image gen     |
| `imagen-4.0-generate-preview`    | image | Imagen 4.0 — photorealistic generation       |
| `veo-3.1-generate-preview`       | video | Veo 3.1 — advanced video generation          |
| `lyria-3-pro-preview`            | audio | Lyria 3 Pro — music generation               |
| `gemini-2.5-flash-preview-tts`   | audio | Gemini 2.5 Flash TTS — text-to-speech        |

### OpenRouter (OpenAI-Compatible)

#### Image Models

| Model                                   | Type       | Description                               |
| --------------------------------------- | ---------- | ----------------------------------------- |
| `recraft/recraft-v4-pro`                | pure-image | Recraft V4 Pro — vector art, illustration |
| `recraft/recraft-v4`                    | pure-image | Recraft V4 — fast illustration            |
| `recraft/recraft-v3`                    | pure-image | Recraft V3 — vector art generation        |
| `sourceful/riverflow-v2-pro`            | pure-image | Riverflow V2 Pro                          |
| `sourceful/riverflow-v2-fast`           | pure-image | Riverflow V2 Fast                         |
| `black-forest-labs/flux.2-max`          | pure-image | FLUX.2 Max — highest quality              |
| `black-forest-labs/flux.2-pro`          | pure-image | FLUX.2 Pro — high quality                 |
| `black-forest-labs/flux.2-flex`         | pure-image | FLUX.2 Flex — flexible generation         |
| `black-forest-labs/flux.2-klein-4b`     | pure-image | FLUX.2 Klein 4B — fast and cheap          |
| `bytedance-seed/seedream-4.5`           | pure-image | Seedream 4.5 — ByteDance image gen        |
| `openai/gpt-5.4-image-2`                | multimodal | GPT-5.4 Image — text + image output       |
| `openai/gpt-5-image`                    | multimodal | GPT-5 Image — text + image output         |
| `openai/gpt-5-image-mini`               | multimodal | GPT-5 Image Mini — fast, cheap            |
| `google/gemini-3.1-flash-image-preview` | multimodal | Gemini 3.1 Flash via OpenRouter           |
| `google/gemini-3-pro-image-preview`     | multimodal | Gemini 3 Pro via OpenRouter               |
| `google/gemini-2.5-flash-image`         | multimodal | Gemini 2.5 Flash via OpenRouter           |

#### Video Models

| Model                         | Description                     |
| ----------------------------- | ------------------------------- |
| `google/veo-3.1`              | Veo 3.1 via OpenRouter          |
| `google/veo-3.1-fast`         | Veo 3.1 Fast via OpenRouter     |
| `google/veo-3.1-lite`         | Veo 3.1 Lite via OpenRouter     |
| `openai/sora-2-pro`           | Sora 2 Pro — OpenAI video       |
| `bytedance/seedance-2.0`      | Seedance 2.0 — ByteDance video  |
| `bytedance/seedance-2.0-fast` | Seedance 2.0 Fast               |
| `bytedance/seedance-1-5-pro`  | Seedance 1.5 Pro                |
| `kwaivgi/kling-v3.0-pro`      | Kling V3.0 Pro — Kuaishou video |
| `kwaivgi/kling-v3.0-std`      | Kling V3.0 Standard             |
| `kwaivgi/kling-video-o1`      | Kling Video O1                  |
| `minimax/hailuo-2.3`          | Hailuo 2.3 — MiniMax video      |
| `alibaba/wan-2.7`             | Wan 2.7 — Alibaba video         |
| `alibaba/wan-2.6`             | Wan 2.6 — Alibaba video         |

---

## OpenRouter Modalities

The `openai-chat-image` adapter automatically sets the correct `modalities` parameter based on model name:

- **Multimodal models** (names containing `gpt`, `gemini`, or `claude`): sends `["text", "image"]`
- **Pure-image models** (Recraft, FLUX, Sourceful, Seedream, etc.): sends `["image"]`

This distinction is required by OpenRouter — pure-image models reject requests with `["text", "image"]` modalities.

---

## Example Invocations

### Image — Pure-image model (OpenRouter)

```json
{
  "model": "black-forest-labs/flux.2-klein-4b",
  "prompt": "A red fox sitting in a snowy forest clearing",
  "params": { "kind": "image" },
  "output_path": "tmp/fox.png"
}
```

### Image — Multimodal model (OpenRouter)

```json
{
  "model": "openai/gpt-5-image-mini",
  "prompt": "A watercolor painting of a lighthouse at dusk",
  "params": { "kind": "image", "aspectRatio": "16:9" },
  "output_path": "tmp/lighthouse.png"
}
```

### Image — Direct Gemini

```json
{
  "model": "gemini-2.5-flash-preview-image",
  "prompt": "A futuristic cityscape with flying cars",
  "params": { "kind": "image" }
}
```

### Video — Async (returns in_progress, poll with media_generate_poll)

```json
{
  "model": "veo-3.1-generate-preview",
  "prompt": "Time-lapse of a flower blooming in a garden",
  "params": { "kind": "video", "durationSeconds": 8 }
}
```

### Speech — TTS

```json
{
  "model": "gemini-2.5-flash-preview-tts",
  "prompt": "Hello! Welcome to our service.",
  "params": { "kind": "speech", "voice": "Kore" }
}
```

---

## Provider Routing

Model resolution searches all configured providers for an exact name match. The first provider with a matching model entry wins. Configuration lives in the `mediaGeneration` config section:

```json
{
  "mediaGeneration": {
    "providers": [
      {
        "id": "google",
        "kind": "gemini",
        "baseUrl": "https://generativelanguage.googleapis.com",
        "apiKeyEnv": "GEMINI_TOKEN",
        "apiVersion": "v1beta",
        "models": [
          { "name": "gemini-2.5-flash-preview-image", "mediaType": "image" },
          { "name": "veo-3.1-generate-preview", "mediaType": "video" },
          {
            "name": "imagen-4.0-generate-preview",
            "mediaType": "image",
            "adapter": "gemini-predict"
          }
        ]
      },
      {
        "id": "openrouter",
        "kind": "openai-compatible",
        "baseUrl": "https://openrouter.ai/api",
        "apiKeyEnv": "OPENROUTER_TOKEN",
        "models": [
          { "name": "black-forest-labs/flux.2-klein-4b", "mediaType": "image" },
          { "name": "openai/gpt-5-image-mini", "mediaType": "image" }
        ]
      }
    ]
  }
}
```

---

## Async Operations

Video generation models (Veo, Sora, etc.) return `{ "status": "in_progress", "operation_id": "..." }`. Use the `media_generate_poll` control op to check completion status.

---

## Error Handling

| Error                                | Cause                         | Resolution                                     |
| ------------------------------------ | ----------------------------- | ---------------------------------------------- |
| `model is required`                  | Missing model parameter       | Provide a model name                           |
| `prompt is required`                 | Missing prompt parameter      | Provide a text prompt                          |
| `params with kind is required`       | Missing or invalid params     | Include `{ "kind": "image" }` (or video, etc.) |
| `Media generation not configured`    | No providers/models in config | Add `mediaGeneration` config section           |
| `API error 404: No endpoints found`  | Wrong modalities for model    | Check model type (pure-image vs multimodal)    |
| `No image content found in response` | Unexpected response format    | Check model supports image output              |

---

## See Also

- [Configuration](../docs/shared.md) — `mediaGeneration` schema
- [Models](../docs/models.md) — LLM model configuration (separate from media models)
