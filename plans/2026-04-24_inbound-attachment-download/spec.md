# Specification

## Interfaces

### Config schema

```ts
/** Attachment handling mode. */
type AttachmentHandlingMode = "download" | "inline" | "hybrid";

interface AttachmentHandlingConfig {
  /** How inbound platform attachments are processed. Default: "download". */
  mode?: AttachmentHandlingMode;
}
```

Added to `ShoggothConfig` under `platforms`:

```ts
interface ShoggothConfig {
  // ... existing fields
  platforms?: {
    // ... existing fields
    attachmentHandling?: AttachmentHandlingConfig;
  };
  agents?: {
    list?: Record<
      string,
      {
        // ... existing fields
        platforms?: {
          // ... existing fields
          attachmentHandling?: AttachmentHandlingConfig;
        };
      }
    >;
  };
}
```

### MessageAttachment extension

```ts
// packages/messaging/src/model.ts
interface MessageAttachment {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  /** Workspace-relative path to the downloaded file. Populated when attachment handling mode includes download. */
  readonly localPath?: string;
}
```

### Download function

```ts
// packages/daemon/src/presentation/attachment-download.ts

interface DownloadInboundAttachmentsOptions {
  /** Attachments from the inbound message. */
  readonly attachments: readonly MessageAttachment[];
  /** Platform message ID (used as filename prefix for collision avoidance). */
  readonly messageId: string;
  /** Absolute path to the agent's workspace root. */
  readonly workspacePath: string;
  /** Agent sandbox credentials for file writes. */
  readonly creds: { readonly uid: number; readonly gid: number };
  /** Max bytes per attachment. Attachments exceeding this are skipped. */
  readonly maxBytes?: number;
  /** Fetch implementation override (for testing). */
  readonly fetchImpl?: typeof fetch;
}

interface DownloadedAttachment extends MessageAttachment {
  /** Workspace-relative path to the downloaded file. */
  readonly localPath: string;
}

/**
 * Download inbound attachments to media/inbound/ in the agent's workspace.
 * Returns a new attachment list with localPath populated on successfully
 * downloaded entries. Failed downloads are included without localPath
 * (logged at warn level, never throws).
 */
function downloadInboundAttachments(
  options: DownloadInboundAttachmentsOptions,
): Promise<readonly MessageAttachment[]>;
```

### Attachment metadata formatter

```ts
// packages/platform-discord/src/attachment-metadata.ts

/**
 * Format attachment metadata for inclusion in userContent.
 * When localPath is present on an attachment, it is included in the output.
 *
 * Example output:
 *   [message has 2 attachment(s)]
 *   - photo.png (image/png, 1.2 KB) → media/inbound/1234567890_photo.png
 *   - report.csv (text/csv, 45.2 KB) → media/inbound/1234567890_report.csv
 */
function formatAttachmentMetadata(attachments: readonly MessageAttachment[]): string;
```

### Mode resolution

```ts
// packages/daemon/src/presentation/attachment-mode.ts

/**
 * Resolve the effective attachment handling mode for a session.
 * Per-agent platforms.attachmentHandling takes precedence over
 * global platforms.attachmentHandling. Default: "download".
 */
function resolveAttachmentHandlingMode(
  config: ShoggothConfig,
  sessionId: string,
): AttachmentHandlingMode;
```

## Data Structures / Schemas

### Zod schema addition

```ts
// In shared config schema
const attachmentHandlingSchema = z
  .object({
    mode: z.enum(["download", "inline", "hybrid"]).default("download"),
  })
  .strict()
  .optional();

// Added to the platforms schema (global and per-agent)
const platformsSchema = z
  .object({
    // ... existing fields
    attachmentHandling: attachmentHandlingSchema,
  })
  .strict()
  .optional();
```

### File naming convention

```
media/inbound/{messageId}_{sanitizedFilename}
```

- `messageId`: platform message identifier (e.g. Discord snowflake)
- `sanitizedFilename`: original filename with `..`, `/`, `\`, and control characters stripped (reuses `sanitizeFilename` logic from `message-tool-handler.ts`)

### Workspace directory structure

```
workspace/
  media/
    inbound/       ← new, created by ensureAgentWorkspaceLayout
  memory/
  skills/
  tmp/
```

## Code Examples

### Config examples

```jsonc
// Default: download only (no inlining)
{
  "platforms": {
    "attachmentHandling": {
      "mode": "download"
    }
  }
}

// Restore previous behavior (base64 inline, no file on disk)
{
  "platforms": {
    "attachmentHandling": {
      "mode": "inline"
    }
  }
}

// Per-agent: vision-heavy agent gets hybrid, others get download
{
  "platforms": {
    "attachmentHandling": {
      "mode": "download"
    }
  },
  "agents": {
    "list": {
      "vision-agent": {
        "platforms": {
          "attachmentHandling": {
            "mode": "hybrid"
          }
        }
      },
      "file-processor": {
        "platforms": {
          "attachmentHandling": {
            "mode": "download"
          }
        }
      }
    }
  }
}
```

### Turn orchestrator integration sketch

```ts
// In orchestrateInboundTurn, wrappedBuildTurn:

const mode = resolveAttachmentHandlingMode(config, sessionId);

let enrichedAttachments = attachments;

// Step 1: Download if mode requires it
if (mode === "download" || mode === "hybrid") {
  enrichedAttachments = await downloadInboundAttachments({
    attachments,
    messageId: msg.id,
    workspacePath: session.workspacePath,
    creds: { uid: session.runtimeUid, gid: session.runtimeGid },
  });
}

// Step 2: Inline image blocks if mode requires it
if (mode === "inline" || mode === "hybrid") {
  return enrichTurnWithImageAttachments(
    turn,
    enrichedAttachments,
    codec,
    formatAttachmentMetadata,
    imageUrlPassthrough,
  );
}

// Step 3: Download-only — just append metadata with paths
return {
  ...turn,
  userContent: turn.userContent + "\n\n" + formatAttachmentMetadata(enrichedAttachments),
};
```

### Hybrid mode: reading from disk instead of re-fetching

```ts
// In image-ingest.ts, new option:

interface ImageIngestOptions {
  readonly codec: ImageBlockCodec;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly imageUrlPassthrough?: boolean;
  /** When set, read image bytes from this local path instead of fetching the URL. */
  readonly localFilePath?: string;
}

// In ingestAttachmentImage:
if (options.localFilePath) {
  const buf = await fs.readFile(options.localFilePath);
  // ... size check, detect media type, return ImageBlock with base64
} else {
  // ... existing fetch logic
}
```
