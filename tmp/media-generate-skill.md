---
id: media-generate
title: Media Generation
description: How to use the builtin-media-generate tool for images, video, speech, and music
tags: [media, image, video, generation]
category: media
enabled: true
---

# Media Generation

Use `builtin-media-generate` to generate images, audio, video, or music via configured AI providers.

## Quick Reference

```
builtin-media-generate({
  model: "model-name",
  prompt: "description of what to generate",
  params: {
    kind: "image" | "video" | "speech" | "music",
    aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4",
    // ...kind-specific params
  }
})
```

## Image Generation

```
builtin-media-generate({
  model: "gpt-4o",
  prompt: "a sunset over mountains",
  params: { kind: "image", aspectRatio: "16:9" }
})
```

### Image Parameters

| Field            | Description                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `aspectRatio`    | Normalized ratio: `"1:1"`, `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"`.                                                |
| `size`           | Alternative to `aspectRatio`. Pixel string (`"1024x1024"`) or tier (`"2K"`). Ignored when `aspectRatio` is set. |
| `numberOfImages` | Number of images to generate.                                                                                   |
| `input_path`     | Workspace-relative path to an input image for editing.                                                          |

### Aspect Ratio & Resolution

The `aspectRatio` field uses **normalized ratio strings**, not pixel dimensions.

- **DALL-E** (`/images/generations`): Maps to fixed pixel sizes (e.g. `"16:9"` → `"1792x1024"`).
- **GPT-image** (`/chat/completions`): Sends `resolution` (tier: `"2K"`) + `aspect_ratio` (normalized).
- **OpenRouter Image API**: Sends `resolution` (tier) + `aspect_ratio` (normalized).

Resolution tiers: `"512"`, `"1K"`, `"2K"` (default), `"4K"`.
Pixel strings are auto-converted to the nearest tier.

Providers may clamp to their supported subset. Unsupported ratios return an error.

## Video Generation

```
builtin-media-generate({
  model: "veo-3.1-generate-preview",
  prompt: "a cat playing in snow",
  params: { kind: "video", aspectRatio: "16:9", durationSeconds: 5 }
})
```

### Video Parameters

| Field             | Description                                                |
| ----------------- | ---------------------------------------------------------- |
| `aspectRatio`     | Normalized ratio (same as image).                          |
| `durationSeconds` | Duration in seconds.                                       |
| `input_path`      | Workspace-relative path to an input image for first frame. |
| `last_frame`      | Base64-encoded last frame image.                           |

Video providers receive `aspect_ratio` (normalized) in their API request.

## Speech (TTS)

```
builtin-media-generate({
  model: "gemini-2.5-flash-preview-tts",
  prompt: "Hello, world!",
  params: { kind: "speech", voice: "Kore" }
})
```

## Music

```
builtin-media-generate({
  model: "lyria-3-pro-preview",
  prompt: "upbeat jazz piano",
  params: { kind: "music", durationSeconds: 30 }
})
```
