/**
 * Platform adapter interface for messaging platforms (Discord, Slack, IRC, etc.).
 *
 * Any platform that wants to integrate with the presentation layer must
 * provide an implementation of {@link PlatformAdapter}.
 */

import type { ThinkingDisplay } from "@shoggoth/shared";

// ---------------------------------------------------------------------------
// Outbound attachment — binary file delivered alongside a message
// ---------------------------------------------------------------------------

export interface OutboundAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Buffer;
}

// ---------------------------------------------------------------------------
// Stream handle — returned by startStream for incremental message updates
// ---------------------------------------------------------------------------

export interface StreamHandle {
  /** Replace the current message content with the full text. */
  setFullContent(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// HITL notice data — payload for human-in-the-loop approval prompts
// ---------------------------------------------------------------------------

export interface HitlNoticeData {
  pendingId: string;
  sessionId: string;
  toolName: string;
  riskTier: string;
  /** Human-readable description lines for the notice. */
  lines: string[];
}

// ---------------------------------------------------------------------------
// Platform capabilities — optional feature flags / helpers
// ---------------------------------------------------------------------------

export interface PlatformCapabilities {
  reactions?: {
    addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
    removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  };
  threads?: boolean;
  embeds?: boolean;
  typing?: {
    start(sessionId: string): void;
    stop(sessionId: string): void;
  };
}

// ---------------------------------------------------------------------------
// Platform adapter — the contract every platform must satisfy
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  /** Send a normal message body to the session's bound channel. */
  sendBody(
    sessionId: string,
    body: string,
    opts?: { replyTo?: string; attachments?: OutboundAttachment[]; thinkingDisplay?: ThinkingDisplay },
  ): Promise<void>;

  /** Send an error message to the session's bound channel. */
  sendError(
    sessionId: string,
    body: string,
    opts?: { replyTo?: string; attachments?: OutboundAttachment[]; thinkingDisplay?: ThinkingDisplay },
  ): Promise<void>;

  /** Begin a streaming message that can be updated incrementally. */
  startStream?(sessionId: string, opts?: { replyTo?: string }): Promise<StreamHandle>;

  /** Post a HITL approval notice (platform may render buttons, reactions, etc.). */
  sendHitlNotice?(
    sessionId: string,
    notice: HitlNoticeData,
  ): Promise<{ channelId: string; messageId: string } | void>;

  /** Maximum character length the platform supports per message. */
  readonly maxBodyLength: number;

  /** Declared capabilities of this platform. */
  readonly capabilities: PlatformCapabilities;
}
