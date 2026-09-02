import type { ShoggothConfig } from "@shoggoth/shared";
import type { MessageAttachment } from "@shoggoth/messaging";
import type { ImageBlockCodec, ChatContentPart } from "@shoggoth/models";
import type { SessionToolLoopFailoverState } from "../sessions/session-tool-loop-model-client.js";
import type { PlatformAdapter, StreamHandle, OutboundAttachment } from "./platform-adapter.js";
import type { InboundSessionTurnInput } from "../messaging/inbound-session-turn.js";
import {
  runInboundSessionTurn,
  type RunInboundSessionTurnOptions,
} from "../messaging/inbound-session-turn.js";
import { formatAssistantReply, formatErrorUserText } from "./reply-formatter.js";
import { getSessionMcpRuntimeRef } from "../sessions/session-mcp-runtime.js";
import { ingestAttachmentImage } from "./image-ingest.js";
import { resolveAttachmentHandlingMode } from "./attachment-mode.js";
import { downloadInboundAttachments } from "./attachment-download.js";
import { resolveEffectiveThinkingDisplay } from "@shoggoth/shared";
import { getLogger } from "../logging.js";

const log = getLogger("turn-orchestrator");

// ---------------------------------------------------------------------------
// Per-turn input provided by the caller
// ---------------------------------------------------------------------------

export interface OrchestrateTurnInput {
  readonly sessionId: string;
  readonly replyToMessageId?: string;
  readonly buildTurn: () => Promise<InboundSessionTurnInput>;
  readonly mcpLifecycle?: RunInboundSessionTurnOptions["mcpLifecycle"];
  readonly logContext?: Record<string, string | undefined>;
  readonly onTurnExecutionFailed?: (err: unknown) => void;
  /**
   * When provided, the orchestrator uses this already-started stream handle
   * instead of calling `adapter.startStream`. Useful when the platform needs
   * to start the stream before a typing indicator (e.g. Discord).
   */
  readonly preStartedStreamHandle?: StreamHandle;
  /** Called when stream start fails (only relevant when no preStartedStreamHandle). */
  readonly onStreamStartFailed?: (message: string) => void;
  /**
   * Platform attachments from the inbound message. Image attachments are
   * converted to ImageBlocks; non-image attachments use the text fallback.
   */
  readonly attachments?: readonly MessageAttachment[];
  /**
   * Codec for the active model provider. Required when `attachments` is set
   * and image ingestion should be attempted. When omitted, all attachments
   * fall through to the text metadata path.
   */
  readonly imageBlockCodec?: ImageBlockCodec;
  /**
   * Text fallback formatter for non-image attachments. When omitted,
   * non-image attachments are silently ignored by the orchestrator
   * (caller is expected to have already handled them in userContent).
   */
  readonly formatAttachmentMetadata?: (attachments: readonly MessageAttachment[]) => string;
  /**
   * When true and the codec supports URL sources, pass image URLs directly
   * to the provider instead of fetching and base64-encoding. Default false.
   */
  readonly imageUrlPassthrough?: boolean;
  /**
   * Attachment handling mode override. When not set, resolved from config
   * via `resolveAttachmentHandlingMode`. Defaults to `'inline'` for backward
   * compatibility when the resolver is not wired up.
   */
  readonly attachmentHandlingMode?: "download" | "inline" | "hybrid";
  /** Absolute path to the agent's workspace root. Required for download/hybrid modes. */
  readonly workspacePath?: string;
  /** Agent sandbox credentials for file writes. Required for download/hybrid modes. */
  readonly creds?: { readonly uid: number; readonly gid: number };
  /** Platform message ID (used for download filename prefix). */
  readonly messageId?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface PresentationTurnOrchestratorDeps {
  readonly config: ShoggothConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly adapter: PlatformAdapter;
  /** Streaming coalesce interval in ms; 0 disables streaming. */
  readonly streamingIntervalMs?: number;
  /** Optional config ref for live-reloaded config (takes precedence over `config`). */
  readonly configRef?: { readonly current: ShoggothConfig };
  /** Prefix prepended to error replies (e.g. "⚠️ "). Default: "". */
  readonly errorReplyPrefix?: string;
}

export class PresentationTurnOrchestrator {
  private readonly deps: PresentationTurnOrchestratorDeps;

  constructor(deps: PresentationTurnOrchestratorDeps) {
    this.deps = deps;
  }

  private get config(): ShoggothConfig {
    return this.deps.configRef?.current ?? this.deps.config;
  }

  private get env(): NodeJS.ProcessEnv | undefined {
    return this.deps.env;
  }

  private get adapter(): PlatformAdapter {
    return this.deps.adapter;
  }

  private get streamingIntervalMs(): number {
    return this.deps.streamingIntervalMs ?? 0;
  }

  async orchestrateInboundTurn(input: OrchestrateTurnInput): Promise<void> {
    const { sessionId, replyToMessageId, buildTurn, logContext, onTurnExecutionFailed } = input;
    // Auto-wire mcpLifecycle from the singleton runtime when the caller doesn't provide it.
    const mcpLifecycle: RunInboundSessionTurnOptions["mcpLifecycle"] =
      input.mcpLifecycle ??
      (() => {
        const rt = getSessionMcpRuntimeRef();
        if (!rt) return undefined;
        return {
          onTurnBegin: () => rt.notifyTurnBegin(sessionId),
          onTurnEnd: () => rt.notifyTurnEnd(sessionId),
        };
      })();
    const { adapter, config, env } = this;
    const maxLen = adapter.maxBodyLength;
    const errorPrefix = this.deps.errorReplyPrefix ?? "";
    const thinkingDisplay = resolveEffectiveThinkingDisplay(config, sessionId);

    const sliceDisplayText = (text: string): string =>
      text.length > maxLen ? text.slice(0, maxLen) : text;

    // If a pre-started stream handle was provided, wrap it; otherwise let
    // runInboundSessionTurn call adapter.startStream lazily.
    let streaming: RunInboundSessionTurnOptions["streaming"];
    if (input.preStartedStreamHandle) {
      streaming = {
        minIntervalMs: this.streamingIntervalMs,
        start: () => Promise.resolve(input.preStartedStreamHandle!),
      };
    } else if (adapter.startStream && this.streamingIntervalMs > 0) {
      streaming = {
        minIntervalMs: this.streamingIntervalMs,
        start: () => adapter.startStream!(sessionId, { replyTo: replyToMessageId }),
        onStartFailed: input.onStreamStartFailed,
      };
    }

    // Wrap buildTurn to inject image block content from attachments.
    const wrappedBuildTurn = async (): Promise<InboundSessionTurnInput> => {
      const turn = await buildTurn();

      const attachments = input.attachments;
      if (!attachments || attachments.length === 0) {
        return turn;
      }

      // Resolve the attachment handling mode.
      const mode = resolveAttachmentHandlingMode(config, sessionId);

      // When no codec is available, fall back to text metadata for all attachments.
      if (!input.imageBlockCodec) {
        if (input.formatAttachmentMetadata) {
          return {
            ...turn,
            userContent: turn.userContent + "\n\n" + input.formatAttachmentMetadata(attachments),
          };
        }
        return turn;
      }

      // --- download mode ---
      if (mode === "download") {
        const enrichedAttachments = await downloadInboundAttachments({
          attachments,
          messageId: input.messageId ?? "",
          workspacePath: input.workspacePath ?? "",
          creds: input.creds,
        });

        // Append metadata with file paths, no image blocks.
        if (input.formatAttachmentMetadata) {
          return {
            ...turn,
            userContent:
              turn.userContent + "\n\n" + input.formatAttachmentMetadata(enrichedAttachments),
          };
        }
        return turn;
      }

      // --- hybrid mode ---
      if (mode === "hybrid") {
        const enrichedAttachments = await downloadInboundAttachments({
          attachments,
          messageId: input.messageId ?? "",
          workspacePath: input.workspacePath ?? "",
          creds: input.creds,
        });

        return enrichTurnWithImageAttachments(
          turn,
          enrichedAttachments,
          input.imageBlockCodec,
          input.formatAttachmentMetadata,
          input.imageUrlPassthrough,
        );
      }

      // --- inline mode (default / current behavior) ---
      return enrichTurnWithImageAttachments(
        turn,
        attachments,
        input.imageBlockCodec,
        input.formatAttachmentMetadata,
        input.imageUrlPassthrough,
      );
    };

    await runInboundSessionTurn({
      buildTurn: wrappedBuildTurn,
      streaming,
      sliceDisplayText,
      formatAssistantReply: (
        latestText: string,
        failoverMeta: SessionToolLoopFailoverState | undefined,
      ) => formatAssistantReply(config, sessionId, env, latestText, failoverMeta),
      formatErrorReply: (err: unknown) => `${errorPrefix}${formatErrorUserText(err)}`,
      sendAssistantBody: (body: string, opts?: { attachments?: readonly OutboundAttachment[] }) =>
        adapter.sendBody(sessionId, body, {
          replyTo: replyToMessageId,
          attachments: opts?.attachments as OutboundAttachment[] | undefined,
          thinkingDisplay,
        }),
      sendErrorBody: (body: string) =>
        adapter.sendError(sessionId, body, {
          replyTo: replyToMessageId,
          thinkingDisplay,
        }),
      // Follow-up message for attachments when streaming (stream edits can't carry files).
      sendAttachments: (attachments: readonly OutboundAttachment[]) =>
        adapter.sendBody(sessionId, "", {
          attachments: attachments as OutboundAttachment[],
          thinkingDisplay,
        }),
      mcpLifecycle,
      logContext,
      onTurnExecutionFailed,
    });
  }
}

// ---------------------------------------------------------------------------
// Image attachment enrichment
// ---------------------------------------------------------------------------

/**
 * Process attachments on an inbound turn: convert image attachments to
 * ImageBlocks and leave non-image attachments as text metadata fallback.
 * Returns a new turn input with enriched `userContent`.
 */
async function enrichTurnWithImageAttachments(
  turn: InboundSessionTurnInput,
  attachments: readonly MessageAttachment[],
  codec: ImageBlockCodec,
  formatFallback?: (attachments: readonly MessageAttachment[]) => string,
  imageUrlPassthrough?: boolean,
): Promise<InboundSessionTurnInput> {
  const imageBlocks: ChatContentPart[] = [];
  const nonImageAttachments: MessageAttachment[] = [];

  const results = await Promise.all(
    attachments.map((att) => {
      // When the attachment has a localPath (hybrid mode), pass it as localFilePath
      // so ingestAttachmentImage reads from disk instead of re-fetching.
      const localFilePath = att.localPath ? att.localPath : undefined;
      return ingestAttachmentImage(att, { codec, imageUrlPassthrough, localFilePath }).then(
        (block) => ({ attachment: att, block }),
        (err) => {
          log.warn("turn_orchestrator.image_ingest_error", {
            filename: att.filename,
            err: String(err),
          });
          return { attachment: att, block: null };
        },
      );
    }),
  );

  for (const { attachment, block } of results) {
    if (block) {
      imageBlocks.push(block);
    } else {
      nonImageAttachments.push(attachment);
    }
  }

  // Nothing ingested — return turn unchanged
  if (imageBlocks.length === 0) return turn;

  // Build structured content: image blocks first, then text body.
  let textBody = turn.userContent;

  // Append text metadata for non-image attachments
  if (nonImageAttachments.length > 0 && formatFallback) {
    textBody = `${textBody}\n\n${formatFallback(nonImageAttachments)}`;
  }

  const parts: ChatContentPart[] = [...imageBlocks, { type: "text", text: textBody }];

  // Serialize structured content as JSON for transcript storage.
  // Downstream phases (transcript-to-chat, provider message mapping) detect
  // JSON arrays and reconstruct ChatContentPart[].
  return {
    ...turn,
    userContent: JSON.stringify(parts),
  };
}
