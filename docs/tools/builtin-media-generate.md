Generate images, audio, video, or music using configured AI providers. Results are written to disk and optionally surfaced inline.

## Parameters

| Param         | Type    | Required | Notes                                                                                        |
| ------------- | ------- | -------- | -------------------------------------------------------------------------------------------- |
| `model`       | string  | yes      | Model name (e.g. `gpt-4o`, `dall-e-3`, `gemini-2.5-flash-image`, `veo-3.1-generate-preview`) |
| `prompt`      | string  | yes      | Generation prompt                                                                            |
| `params`      | object  | yes      | Discriminated by `kind` (see below)                                                          |
| `output_path` | string  | no       | Workspace-relative output path. Auto-generated if omitted.                                   |
| `show`        | boolean | no       | Include generated image as content parts in result. Default `true`.                          |
| `timeout_ms`  | number  | no       | Timeout for async generation (e.g. video).                                                   |

### `params` fields

| Field             | Type   | Applicable   | Description                                                                                         |
| ----------------- | ------ | ------------ | --------------------------------------------------------------------------------------------------- |
| `kind`            | string | all          | **Required.** `"image"`, `"video"`, `"speech"`, or `"music"`                                        |
| `aspectRatio`     | string | image, video | Normalized ratio string: `"1:1"`, `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"`                              |
| `size`            | string | image        | Pixel string (`"1024x1024"`), tier string (`"2K"`), or auto-inferred. Ignored if `aspectRatio` set. |
| `numberOfImages`  | number | image        | Number of images to generate.                                                                       |
| `durationSeconds` | number | video, music | Duration in seconds.                                                                                |
| `input_path`      | string | image, video | Workspace-relative path to an input image for editing.                                              |
| `last_frame`      | string | video        | Base64-encoded last frame image.                                                                    |
| `voice`           | string | speech       | Voice name for TTS.                                                                                 |

## Aspect Ratio & Resolution

`aspectRatio` uses **normalized ratio strings** (`"1:1"`, `"16:9"`, etc.), not pixel dimensions.

| Adapter                             | Behaviour                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| OpenAI Images API (DALL-E)          | Maps to fixed pixel sizes (e.g. `"16:9"` → `"1792x1024"`). Sends pixel `size`. |
| OpenAI Chat Completions (GPT-image) | Sends `resolution` (tier) + `aspect_ratio` (normalized) in request body.       |
| OpenRouter Image API                | Sends `resolution` (tier) + `aspect_ratio` (normalized).                       |
| OpenRouter Video API                | Forwards `aspect_ratio` (normalized).                                          |

### Resolution tiers

Tiered providers use: `"512"`, `"1K"`, `"2K"` (default), `"4K"`.

Conversion from pixel strings: `≥3840px → "4K"`, `≥1920px → "2K"`, `≥960px → "1K"`, `<960px → "512"`.

Providers may clamp to their supported subset. Unsupported ratios return an error.

## Examples

**Image with widescreen aspect ratio:**

```json
{
  "model": "gpt-4o",
  "prompt": "a sunset over mountains",
  "params": { "kind": "image", "aspectRatio": "16:9" }
}
```

**Image with specific size (DALL-E):**

```json
{
  "model": "dall-e-3",
  "prompt": "a cat wearing a hat",
  "params": { "kind": "image", "size": "1024x1024" }
}
```

**Video generation:**

```json
{
  "model": "veo-3.1-generate-preview",
  "prompt": "a cat playing in snow",
  "params": { "kind": "video", "aspectRatio": "16:9", "durationSeconds": 5 }
}
```

**TTS:**

```json
{
  "model": "gemini-2.5-flash-preview-tts",
  "prompt": "Hello, world!",
  "params": { "kind": "speech", "voice": "Kore" }
}
```
