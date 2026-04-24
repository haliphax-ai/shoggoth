# Implementation

## Phase 1: Config schema and mode resolution

Add the `platforms.attachmentHandling` config section and the function to resolve the effective mode for a session.\n\n- Add `attachmentHandlingSchema` to the platforms schema in shared config (global and per-agent)

- Add `resolveAttachmentHandlingMode` function that checks per-agent config first, falls back to global, defaults to `download`
- Unit tests for resolution logic: per-agent wins, global fallback, default when unset, invalid values rejected by zod

**Files:**

- `packages/shared/src/schema.ts` — add `attachmentHandlingSchema` to platforms schema (global and per-agent)
- `packages/daemon/src/presentation/attachment-mode.ts` (new) — `resolveAttachmentHandlingMode`
- `packages/daemon/test/presentation/attachment-mode.test.ts` (new) — resolution tests

## Phase 2: Workspace layout and download function

Create the `media/inbound/` directory in the workspace layout and implement the download function.

- Add `media/inbound` to `ensureAgentWorkspaceLayout` mkdir list
- Implement `downloadInboundAttachments`: fetch each URL, write to `media/inbound/{messageId}_{sanitizedFilename}`, return enriched attachment list with `localPath`
- File writes use `runAsUser` for sandbox compliance
- Parallel downloads via `Promise.allSettled`, failed downloads logged and returned without `localPath`
- Size cap enforcement (Content-Length pre-check + buffer size guard)
- Unit tests with mocked fetch and filesystem

**Files:**

- `packages/daemon/src/workspaces/agent-workspace-layout.ts` — add `media/inbound` to mkdir list
- `packages/daemon/src/presentation/attachment-download.ts` (new) — `downloadInboundAttachments`
- `packages/daemon/test/presentation/attachment-download.test.ts` (new) — download tests

## Phase 3: MessageAttachment localPath and metadata formatting

Extend the `MessageAttachment` interface and update the metadata formatter to include file paths.

- Add optional `localPath` to `MessageAttachment` in `@shoggoth/messaging`
- Update `formatAttachmentMetadata` to append ` → {localPath}` when present
- Unit tests for formatter with and without `localPath`

**Files:**

- `packages/messaging/src/model.ts` — add `localPath` to `MessageAttachment`
- `packages/platform-discord/src/attachment-metadata.ts` — include `localPath` in output
- `packages/platform-discord/test/attachment-metadata.test.ts` — updated formatter tests

## Phase 4: Turn orchestrator integration

Wire the mode resolution, download step, and conditional image block injection into the turn orchestrator.

- In `turn-orchestrator.ts`, resolve the attachment handling mode before processing attachments
- `download` mode: call `downloadInboundAttachments`, format metadata with paths, skip image block injection
- `inline` mode: current behavior unchanged
- `hybrid` mode: download first, then inject image blocks (reading from disk via new `localFilePath` option on `ingestAttachmentImage` to avoid re-fetching)
- Update `image-ingest.ts` to accept optional `localFilePath` for reading from disk
- Thread workspace path and sandbox creds through from `platform.ts` into the orchestrator input

**Files:**

- `packages/daemon/src/presentation/turn-orchestrator.ts` — mode-aware attachment handling
- `packages/daemon/src/presentation/image-ingest.ts` — add `localFilePath` option
- `packages/platform-discord/src/platform.ts` — pass workspace path and creds into orchestrator
- `packages/daemon/test/presentation/turn-orchestrator.test.ts` — tests for all three modes
- `packages/daemon/test/presentation/image-ingest.test.ts` — test `localFilePath` read path

## Phase 5: Documentation and config validation

Update docs and add config validation tests.

- Update `docs/shared.md` or relevant config docs with `platforms.attachmentHandling` section
- Add config hot-reload support for `platforms.attachmentHandling` (mode changes take effect on next inbound message, no restart required)
- End-to-end validation: config with all three modes parses correctly, dynamic config update works

**Files:**

- `docs/shared.md` or `docs/daemon.md` — document `attachmentHandling` config
- `packages/daemon/src/config-hot-reload.ts` — ensure `attachmentHandling` is picked up on reload
- `packages/shared/test/schema.test.ts` — config validation tests for new section
