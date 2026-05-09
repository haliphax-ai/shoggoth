---
id: media-generate
title: Media Generation
description: Multi-provider adapter for generating images, video, speech, and music via OpenRouter and direct Gemini
tags:
  [
    media,
    generation,
    image,
    video,
    speech,
    music,
    openai,
    openrouter,
    gemini,
    flux,
    recraft,
    minimax,
    imagen,
    veo,
  ]
category: media
enabled: true
---

The media generation skill provides unified access to multiple media generation providers through a pluggable adapter architecture. Provider routing is automatic based on configuration — specify the model and the appropriate adapter handles the request.

---

## Adapter Types

The media system supports 6 adapter types, each optimized for a specific media kind:

| Adapter           | Kind     | Use Case                                   |
| ----------------- | -------- | ------------------------------------------ |
| `image`           | `image`  | Static image generation from text prompts  |
| `video`           | `video`  | Video generation from text or image inputs |
| `speech`          | `speech` | Text-to-speech audio generation            |
| `music`           | `music`  | Music/audio track generation               |
| `image-edit`      | `image`  | Image editing (inpainting, outpainting)    |
| `image-variation` | `image`  | Creating variations of existing images     |

---

## Models

### Available via OpenRouter

OpenRouter aggregates many providers. Use these model identifiers when routing through OpenRouter:

| Model                          | Kind  | Description                                                     |
| ------------------------------ | ----- | --------------------------------------------------------------- |
| `black-forest-labs/flux.2-pro` | image | Flux 2 Pro — high-quality artistic image generation             |
| `recraft/recraft-v3`           | image | Recraft V3 — vector art and illustration generation             |
| `openai/gpt-5-image`           | image | OpenAI GPT-5 Image — unified image understanding and generation |
| `minimax/hailuo-2.3`           | video | Hailuo 2.3 — video generation from text descriptions            |
| `veo-3.1-generate-preview`     | video | Google Veo 3.1 — advanced video generation                      |

### Available via Direct Gemini

Some models are accessed directly through Google's Gemini API:

| Model                     | Kind  | Description                                                              |
| ------------------------- | ----- | ------------------------------------------------------------------------ |
| `gemini-2.5-flash-image`  | image | Gemini 2.5 Flash Image — fast image generation with multimodal reasoning |
| `imagen-3.0-generate-002` | image | Google Imagen 3.0 — photorealistic and artistic image generation         |

---

## Params Structure

All media generation requests use a standardized params structure:

```typescript
interface MediaParams {
  /** Media kind: image, video, speech, or music */
  kind: "image" | "video" | "speech" | "music";
  /** Model identifier (e.g., 'black-forest-labs/flux.2-pro') */
  model: string;
  /** Text prompt describing the desired output */
  prompt: string;
  /** Optional: negative prompt to exclude certain elements */
  negativePrompt?: string;
  /** Optional: number of images/videos to generate (default: 1) */
  numOutputs?: number;
  /** Optional: aspect ratio (e.g., '16:9', '1:1', '9:16') */
  aspectRatio?: string;
  /** Optional: output format (e.g., 'png', 'jpg', 'mp4') */
  format?: string;
  /** Optional: seed for reproducible results */
  seed?: number;
  /** Optional: image URL for edit/variation endpoints */
  imageUrl?: string;
}
```

---

## Example Invocations

### Image Generation (OpenRouter)

```typescript
// Generate an image using Flux 2 Pro via OpenRouter
const result = await builtin_skills.execute({
  action: "generate",
  params: {
    kind: "image",
    model: "black-forest-labs/flux.2-pro",
    prompt: "A serene mountain lake at sunset with reflection",
    aspectRatio: "16:9",
    numOutputs: 1,
  },
});
```

### Image Generation (Direct Gemini)

```typescript
// Generate an image using Gemini 2.5 Flash directly
const result = await builtin_skills.execute({
  action: "generate",
  params: {
    kind: "image",
    model: "gemini-2.5-flash-image",
    prompt: "A futuristic cityscape with flying cars",
    aspectRatio: "16:9",
  },
});
```

### Video Generation (OpenRouter)

```typescript
// Generate a video using Hailuo via OpenRouter
const result = await builtin_skills.execute({
  action: "generate",
  params: {
    kind: "video",
    model: "minimax/hailuo-2.3",
    prompt: "Waves crashing on a rocky shore, slow motion",
    duration: 5,
  },
});
```

### Video Generation (Direct Gemini)

```typescript
// Generate a video using Veo via OpenRouter
const result = await builtin_skills.execute({
  action: "generate",
  params: {
    kind: "video",
    model: "veo-3.1-generate-preview",
    prompt: "Time-lapse of a flower blooming",
    duration: 10,
  },
});
```

### Image Editing

```typescript
// Edit an image (inpainting)
const result = await builtin_skills.execute({
  action: "edit",
  params: {
    kind: "image",
    model: "black-forest-labs/flux.2-pro",
    prompt: "Add a red balloon to the scene",
    imageUrl: "https://example.com/input-image.png",
  },
});
```

### Image Variation

```typescript
// Create variations of an existing image
const result = await builtin_skills.execute({
  action: "variate",
  params: {
    kind: "image",
    model: "recraft/recraft-v3",
    prompt: "Same subject, different artistic style",
    imageUrl: "https://example.com/original.png",
    numOutputs: 3,
  },
});
```

### Speech Generation

```typescript
// Generate speech audio from text
const result = await builtin_skills.execute({
  action: "generate",
  params: {
    kind: "speech",
    model: "openai/tts-1",
    prompt: "Hello! Welcome to our service.",
    voice: "alloy",
    format: "mp3",
  },
});
```

### Music Generation

```typescript
// Generate background music
const result = await builtin_skills.execute({
  action: "generate",
  params: {
    kind: "music",
    model: "openai/music-gen",
    prompt: "Upbeat electronic background music for a tech demo",
    duration: 30,
    format: "mp3",
  },
});
```

---

## Provider Routing

Provider routing is automatic based on the model identifier:

- **Models with `/` separator** (e.g., `black-forest-labs/flux.2-pro`) → routed to **OpenRouter**
- **Known direct Gemini models** (`gemini-2.5-flash-image`, `imagen-3.0-generate-002`) → routed to **Gemini API directly**

Configuration controls provider behavior:

```json
{
  "media": {
    "providers": {
      "openrouter": {
        "enabled": true,
        "apiKey": "${OPENROUTER_API_KEY}"
      },
      "gemini": {
        "enabled": true,
        "apiKey": "${GEMINI_API_KEY}"
      }
    },
    "defaultProvider": "openrouter",
    "fallbackEnabled": true
  }
}
```

Set `fallbackEnabled: true` to automatically retry failed requests with an alternate provider.

---

## Error Handling

Common error scenarios:

| Error                      | Cause                            | Resolution                                     |
| -------------------------- | -------------------------------- | ---------------------------------------------- |
| `PROVIDER_UNAVAILABLE`     | API key missing or provider down | Check API keys in config                       |
| `MODEL_NOT_FOUND`          | Model identifier invalid         | Verify model name from the tables above        |
| `RATE_LIMIT_EXCEEDED`      | Too many requests                | Implement backoff or reduce request rate       |
| `CONTENT_POLICY_VIOLATION` | Prompt flagged by provider       | Revise prompt to comply with provider policies |

---

## See Also

- [Models Documentation](../docs/models.md) — available models and capabilities
- [Configuration](../docs/shared.md) — media provider configuration schema
