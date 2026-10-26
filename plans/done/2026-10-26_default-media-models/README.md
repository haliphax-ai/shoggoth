---
date: 2026-10-26 # Date the plan was created (YYYY-MM-DD)
completed: 2026-10-26 # Date completed (YYYY-MM-DD), or "never"
---

# Default models per media generation type

## Motivation

Every media generation call today requires an explicit `model` argument: the
`media-generate` tool descriptor marks it required, the `media_generate`
control op rejects payloads without it, and the CLI `media generate` command
errors when `--model` is missing. Operators must therefore repeat the same
model reference for every generation of a given media type, and agents have no
signal as to which model is "the one to use" for images, video, or audio.

This plan adds per-media-type default models to the `mediaGeneration` config
block, following the same pattern already established by `decision.defaultModel`
and `rerank.defaultModel`.

## Design

### Config schema

A new `defaults` block inside `mediaGeneration`, holding the default model for
each generic media type in `provider-id/model-id` format, plus an optional
`suggestions` block for specialized media types:

```jsonc
{
  "mediaGeneration": {
    "defaults": {
      "image": "google/gemini-2.5-flash-image",
      "video": "google/veo-3.1",
      "audio": "google/lyria-3-pro-preview",
      "suggestions": {
        "music": "google/lyria-3-pro-preview",
        "tts": "google/gemini-2.5-flash-preview-tts",
      },
    },
    "providers": {
      /* ... unchanged ... */
    },
  },
}
```

- `defaults.image`, `defaults.video`, `defaults.audio` — optional, must each
  reference a configured model as `provider-id/model-id`.
- `defaults.suggestions` — optional map of specialized media type (`music`,
  `tts`) to a _suggested_ model reference. Suggestions are validated against
  configured models but never auto-applied; they exist purely as a hint to the
  agent, exposed alongside the generic defaults (e.g. the audio default may be
  a poor choice for TTS).

### Media type mapping

The tool's `params.kind` values map onto generic media types for default
lookup:

| `params.kind` | generic media type                                                          |
| ------------- | --------------------------------------------------------------------------- |
| `image`       | `image`                                                                     |
| `video`       | `video`                                                                     |
| `speech`      | `audio` (falls back to the `tts` suggestion when no audio default exists)   |
| `music`       | `audio` (falls back to the `music` suggestion when no audio default exists) |

### Resolution points

1. **Control op (`media_generate`)** — `model` becomes optional. When omitted,
   it resolves from `defaults` using the request's `params.kind`. If neither a
   model param nor a configured default exists, the op returns
   `ERR_INVALID_PAYLOAD` with an explanatory message.
2. **Tool handler (`media-generate`)** — `model` becomes optional; passes the
   omission through so the control op performs the single source-of-truth
   resolution.
3. **CLI (`media generate`)** — `--model` becomes optional. The control op
   errors when neither is present, and the CLI surfaces that error.
4. **Tool descriptor** — `model` drops out of `required` when all three generic
   defaults are configured; its description and the tool description list the
   configured defaults and the specialized suggestions so the agent sees them
   as hints.

### Validation

`shoggothMediaGenerationConfigSchema` gains a `superRefine` (matching the
decision/rerank pattern): every default/suggestion reference must be a
`provider-id/model-id` pair that resolves to a configured provider model, and
malformed references are rejected with an issue on the offending path.

## Testing strategy

Red/green TDD across four test files:

- `packages/daemon/test/media/media-generate-control-op.test.ts` — schema
  acceptance/rejection of the `defaults` block; op behavior when `model` is
  omitted (default resolution, error when no default).
- `packages/daemon/test/sessions/media-generate-tool-finalizer.test.ts` —
  descriptor reflects configured defaults/suggestions (required list, model
  description).
- `packages/cli/test/run-media.test.ts` — `--model` optional at parse time;
  omitted-model payload forwarded to the control op.
- `packages/daemon/test/media/media-generation-service.test.ts` — service-level
  default resolution and error when no model and no default are configured.

## Considerations

- Decision/rerank `defaultModel` are resolved _in their services_; media
  generation resolves in the `MediaGenerationService.generate` entry point so
  the control op, tool handler, and CLI share one code path.
- The service's `generate` request model becomes optional; adapters always
  receive a concrete model (resolution happens before adapter dispatch).
- Backward compatibility is explicitly not a concern (pre-release software),
  but existing configs without `defaults` remain valid — all new fields are
  optional at the schema level; the requirement on defaults only applies to
  requests that omit `model`.

## References

- `packages/shared/src/schema/runtime.ts` — media generation + decision/rerank schemas
- `packages/daemon/src/control/integration-ops.ts` — `media_generate` op
- `packages/daemon/src/media/media-generation-service.ts` — generation entry point
- `packages/daemon/src/sessions/session-mcp-tool-context.ts` — tool descriptor
- `packages/daemon/src/sessions/builtin-handlers/media-generate-handler.ts` — tool handler
- `packages/cli/src/run-media.ts` — CLI
