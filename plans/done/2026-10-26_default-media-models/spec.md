# Specification — Default models per media generation type

## Config schema additions

In `packages/shared/src/schema/runtime.ts`, inside `shoggothMediaGenerationConfigSchema`:

```ts
const mediaGenerationSuggestionKind = z.enum(["music", "tts"]);

export const shoggothMediaGenerationConfigSchema = z
  .object({
    defaults: z
      .object({
        image: modelRef.optional(),   // "provider-id/model-id"
        video: modelRef.optional(),
        audio: modelRef.optional(),
        suggestions: z
          .record(mediaGenerationSuggestionKind, modelRef)
          .optional(),
      })
      .strict()
      .optional(),
    providers: /* unchanged */,
    adapterDefaults: /* unchanged */,
    outputDirectory: /* unchanged */,
  })
  .strict()
  .superRefine((cfg, ctx) => { /* validate each ref against providers */ });

type modelRef = z.string().min(1);
```

Validation rule (per reference `ref` at `path`):

```ts
const known = Object.entries(cfg.providers ?? {}).some(([id, p]) =>
  Object.keys(p.models ?? {}).some((name) => `${id}/${name}` === ref),
);
if (!known) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `${ref} must be a configured model in provider-id/model-id format`,
  });
}
```

`path` is `["defaults", "image"]` etc., or `["defaults", "suggestions", "tts"]`.

## Media type resolution helper

Shared mapping used by descriptor + control op:

```ts
/** params.kind → generic media type key in `defaults`. */
export const MEDIA_KIND_TO_DEFAULT_TYPE: Record<string, "image" | "video" | "audio"> = {
  image: "image",
  video: "video",
  speech: "audio",
  music: "audio",
};
```

Resolution order when `model` is omitted and `params.kind` is given:

1. `defaults[MEDIA_KIND_TO_DEFAULT_TYPE[kind]]`
2. for `speech`/`music`: `defaults.suggestions.tts` / `defaults.suggestions.music`
3. otherwise: error (see below)

Error message (single wording, used by op and service):

```
model is required: no model given and no default model configured for media type "<kind>"
```

When `params.kind` itself is missing, `params` is already rejected by the
existing `media_generate params requires kind` validation — resolution never
runs without a kind.

## Control op (`media_generate`)

```ts
const modelRaw = pl.model;
if (modelRaw !== undefined && modelRaw !== null && (typeof modelRaw !== "string" || !modelRaw)) {
  throw new IntegrationOpError(
    "ERR_INVALID_PAYLOAD",
    "media_generate model must be a non-empty string",
  );
}
const model = typeof modelRaw === "string" && modelRaw ? modelRaw : undefined;
// ... prompt/params validation unchanged ...
return svc.generate({
  model, // now `string | undefined`
  prompt,
  params,
  output_path,
  timeout_ms,
});
```

Default resolution happens inside `MediaGenerationService.generate` (single
source of truth):

```ts
interface GenerateRequest {
  model?: string;
  prompt: string;
  params: MediaGenerateParams;
  output_path: string;
  timeout_ms?: number;
}
```

In `generate()`:

```ts
const model =
  req.model ??
  this.defaults?.[MEDIA_KIND_TO_DEFAULT_TYPE[req.params.kind]] ??
  (req.params.kind === "speech" ? this.defaults?.suggestions?.tts : undefined) ??
  (req.params.kind === "music" ? this.defaults?.suggestions?.music : undefined);

if (!model) {
  return {
    status: "error",
    error: `model is required: no model given and no default model configured for media type "${req.params.kind}"`,
  };
}
```

`MediaGenerationService.fromConfig` passes `config.defaults` through; the
constructor accepts `defaults?: ShoggothMediaGenerationConfig["defaults"]`.

## Tool handler

`model` optional — remove the `if (!model)` early return; the control op
performs validation and returns the error as `resultJson`.

## Tool descriptor

`MEDIA_GENERATE_TOOL_DESCRIPTOR` becomes a factory:

```ts
function mediaGenerateToolDescriptor(config: ShoggothConfig): AggregatedTool;
```

- `model` description lists configured defaults:
  `Optional. Defaults: image 'p/m', video 'p/m', audio 'p/m'.`
  or `Required — no default model is configured for any media type.`
- `description` appends the suggestions as hints:
  ` Suggested models: music 'p/m', tts 'p/m'.`
- `required` array: omit `model` when _all three_ generic defaults
  (`image`, `video`, `audio`) are configured; otherwise keep it required.
- `createMediaGenerateToolFinalizer` calls the factory with `config`.

## CLI

`parseMediaGenerateArgs`: `model` optional — drop the
`if (!model) return { ok: false, error: "--model is required" }` guard.
Payload type: `model?: string`. The control op returns the
"no default configured" error, which the CLI already surfaces (exit code 1).

Help text: `shoggoth media generate [--model <model>] --prompt <prompt> ...`
with a note that `--model` defaults to the configured media-type default.
