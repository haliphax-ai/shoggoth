---
date: 2026-04-24
completed: never
---

# Inbound Attachment Download

## Summary

Store inbound platform attachments as files in the agent's workspace (`media/inbound/`) instead of (or in addition to) base64-inlining them into the model's context. A new `platforms.attachmentHandling` config controls the behavior at global and per-agent levels with three modes: `download` (default), `inline`, and `hybrid`.

## Motivation

Today, when a Discord message includes an attachment, the daemon fetches the image bytes, base64-encodes them, and injects them directly into `userContent` as `ChatContentPart[]` image blocks. Non-image attachments get a text-only metadata fallback. This has two problems:

1. The agent has no access to the actual file on disk. If the task is "resize this image" or "convert this CSV," the agent must ask the user to re-upload or use `attachment-download` from the message tool — an extra round-trip that shouldn't be necessary.
2. Large base64 payloads bloat the transcript and consume context window tokens even when the agent doesn't need to "see" the image content (e.g. "deploy this binary," "attach this file to the PR").

By downloading attachments to a workspace folder first, the agent always has a file path it can operate on. The operator chooses whether the content is also inlined for multimodal understanding, downloaded only, or both.

## Design

### Attachment handling modes

Three modes, configurable globally and per-agent:

| Mode       | Behavior                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `download` | Fetch attachment to `media/inbound/`, pass file path metadata to the agent. No image block injection. **Default.**                                  |
| `inline`   | Current behavior. Fetch and base64-encode images into `ChatContentPart[]` image blocks. Non-images get text metadata only. No file written to disk. |
| `hybrid`   | Download to `media/inbound/` AND inject image blocks for image attachments. Agent gets both the file path and the visual content in context.        |

### Config schema

New optional `attachmentHandling` section under `platforms` (global) and `agents.list.<id>.platforms` (per-agent):

```jsonc
{
  // Global default
  "platforms": {
    "attachmentHandling": {
      "mode": "download", // "download" | "inline" | "hybrid"
    },
  },
  // Per-agent override
  "agents": {
    "list": {
      "my-agent": {
        "platforms": {
          "attachmentHandling": {
            "mode": "hybrid",
          },
        },
      },
    },
  },
}
```

Per-agent config takes precedence over global. When neither is set, the default is `download`.

### Workspace layout

`ensureAgentWorkspaceLayout` adds `media/inbound/` to the directories it creates alongside `skills/`, `memory/`, and `tmp/`. This is the canonical location for downloaded attachments.

### File naming

Downloaded files are named `{messageId}_{sanitizedFilename}` to avoid collisions when multiple messages attach files with the same name. The `messageId` is the platform message snowflake (Discord) or equivalent identifier. Filename sanitization strips path traversal sequences and control characters (same logic as `sanitizeFilename` in `message-tool-handler.ts`).

Example: `1234567890_photo.png` → `media/inbound/1234567890_photo.png`

### Download mechanism

A new function `downloadInboundAttachments` in the daemon's presentation layer:

1. For each `MessageAttachment` on the inbound message, fetch the URL and write bytes to `media/inbound/{messageId}_{filename}`.
2. Return an enriched attachment list with `localPath` populated on each entry.
3. Respect the existing `MAX_IMAGE_BLOCK_BYTES` size cap — attachments exceeding it are skipped with a warning log. The metadata still reports them (with a size note) so the agent knows they exist.

The fetch reuses the same pattern as `image-ingest.ts` (Content-Length pre-check, buffer size guard). File writes use `runAsUser` to respect the agent's UID/GID sandbox.

### Turn orchestrator changes

The `enrichTurnWithImageAttachments` function in `turn-orchestrator.ts` is the integration point. Based on the resolved mode:

- `download`: Skip image block injection entirely. Call `downloadInboundAttachments`, then format metadata with file paths via an updated `formatAttachmentMetadata`.
- `inline`: Current behavior, unchanged. No download step.
- `hybrid`: Call `downloadInboundAttachments` first, then proceed with image block injection as today. Metadata includes file paths for all attachments (images get both the inline block and the path).

### Metadata format update

`formatAttachmentMetadata` gains an optional `localPath` field per attachment:

```
[message has 2 attachment(s)]
- photo.png (image/png, 1.2 KB) → media/inbound/1234567890_photo.png
- report.csv (text/csv, 45.2 KB) → media/inbound/1234567890_report.csv
```

In `inline` mode (no download), paths are omitted and the format is unchanged from today.

### Data flow by mode

**`download` mode:**

```
Discord attachment
  → fetch URL → write to media/inbound/
  → formatAttachmentMetadata (with paths)
  → append metadata text to userContent
  → no image blocks
```

**`inline` mode (current behavior):**

```
Discord attachment
  → ingestAttachmentImage (fetch + base64 or URL passthrough)
  → ChatContentPart[] image blocks prepended to userContent
  → non-image attachments get text metadata (no paths)
```

**`hybrid` mode:**

```
Discord attachment
  → fetch URL → write to media/inbound/
  → ingestAttachmentImage (from disk or re-fetch for base64/URL passthrough)
  → ChatContentPart[] image blocks prepended to userContent
  → formatAttachmentMetadata (with paths) appended for non-image attachments
  → image attachments have both inline blocks AND path metadata
```

In `hybrid` mode, `ingestAttachmentImage` can read from the already-downloaded file on disk instead of re-fetching the URL, avoiding a redundant network round-trip.

### Platform agnosticism

The download logic lives in the daemon's presentation layer, not in `platform-discord`. The `MessageAttachment` interface (in `@shoggoth/messaging`) gains an optional `localPath` field that any platform adapter can populate. The config schema is platform-agnostic. When other platforms (Slack, Matrix) are added, they get the same behavior for free.

## Testing Strategy

- Unit tests for `downloadInboundAttachments`: mock fetch, verify file write path, filename sanitization, size cap enforcement, error handling (fetch failure → skip with warning).
- Unit tests for config resolution: per-agent overrides global, default is `download`, invalid values rejected by schema.
- Unit tests for `formatAttachmentMetadata` with `localPath` present and absent.
- Integration tests for each mode through the turn orchestrator: verify `download` produces no image blocks but does produce file paths; `inline` produces image blocks but no files; `hybrid` produces both.
- Verify `runAsUser` sandbox: files are written with the agent's UID/GID, not root.
- Edge cases: oversized attachment skipped, fetch failure doesn't block the turn, message with zero attachments is a no-op, duplicate filenames across messages don't collide.

## Considerations

- Disk usage: `media/inbound/` will accumulate files. This should be subject to the existing retention system or a new `maxAgeDays` config for inbound media. Deferred to a follow-up — operators can use `tmp/` cleanup or cron in the meantime.
- CDN URL expiry: Discord CDN URLs are signed and expire. In `download` mode this is a non-issue since we fetch immediately. In `inline` mode with URL passthrough, the existing expiry risk remains (unchanged from today).
- Non-image file types: `download` mode benefits all file types equally — CSVs, PDFs, binaries, etc. all get a workspace path. `inline` and `hybrid` only inject image blocks for recognized image MIME types; everything else gets metadata text.
- Transcript size: `download` mode significantly reduces transcript bloat for image-heavy conversations since base64 payloads are replaced with short path strings.
- Concurrent downloads: Multiple attachments on a single message are downloaded in parallel (`Promise.all`). A per-message concurrency limit isn't needed since Discord caps attachments at 10 per message.
- The `attachment-download` action on the message tool remains available and unchanged. It serves a different use case: downloading attachments from arbitrary messages the agent discovers via `get`/`search`, not just the current inbound message.

## Migration

No database migration. The `platforms.attachmentHandling` config section is new and optional — omitting it preserves the new default (`download`). To restore the previous behavior exactly, set `mode: inline`. The `media/inbound/` directory is created automatically by the workspace layout on next boot.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
