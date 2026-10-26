# Addendum — post-implementation refinement

During implementation the suggested-model semantics were tightened to match
the issue: `defaults.suggestions` (music, tts) are **never auto-applied** —
only the generic defaults (image, video, audio) are resolved when `model` is
omitted. A speech/music request with no `audio` default therefore errors even
if a suggestion is configured; the suggestion exists purely as a hint
surfaced in the tool descriptor so the agent can pass it explicitly (e.g. a
TTS-specialized model instead of an audio default like Lyria).

Additionally, default references are resolved as `provider-id/model-id`
(routing to the right provider before falling back to bare-name matching),
and adapters receive the raw model name on the wire — the provider prefix is
only Shoggoth's routing concern.
