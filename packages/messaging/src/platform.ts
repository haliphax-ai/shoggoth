/**
 * Platform-agnostic abstractions for pluggable messaging platforms.
 *
 * These interfaces define the contract that any messaging platform (Discord, Slack, etc.)
 * must implement to integrate with Shoggoth's messaging layer.
 */

import type { InternalMessage } from "./model";
import type { AgentToAgentBus } from "./a2a";
import type { MessagingAdapterCapabilities } from "./capabilities";

// ---------------------------------------------------------------------------
// SentMessageRef
// ---------------------------------------------------------------------------

/** Platform-agnostic reference to a sent message. */
export interface SentMessageRef {
  readonly channelId: string;
  readonly messageId: string;
}

// ---------------------------------------------------------------------------
// PlatformOutbound
// ---------------------------------------------------------------------------

/**
 * Platform-agnostic outbound message sender.
 *
 * Each platform implementation translates an {@link InternalMessage} into
 * the platform's native wire format and delivers it.
 */
export interface PlatformOutbound {
  send(msg: InternalMessage): Promise<SentMessageRef>;
}

// ---------------------------------------------------------------------------
// PlatformStreamingOutbound / PlatformStreamHandle
// ---------------------------------------------------------------------------

/**
 * Handle to an in-progress streaming message on a platform.
 *
 * The platform creates a placeholder message on {@link PlatformStreamingOutbound.start},
 * then the caller pushes incremental or final content through this handle.
 */
export interface PlatformStreamHandle {
  /** Platform-specific identifier for the message being streamed. */
  readonly messageId: string;
  /** Replace the message content with an intermediate update. */
  update(text: string): Promise<void>;
  /** Replace the message content with the final text and close the stream. */
  finish(text: string): Promise<void>;
}

/**
 * Factory for streaming outbound messages on a platform.
 *
 * Streaming allows the agent to progressively edit a single message
 * (e.g. token-by-token LLM output) rather than sending many discrete messages.
 */
export interface PlatformStreamingOutbound {
  /** Create a placeholder message and return a handle for incremental updates. */
  start(): Promise<PlatformStreamHandle>;
}

// ---------------------------------------------------------------------------
// PlatformTransportEnvelope
// ---------------------------------------------------------------------------

/**
 * Platform-agnostic transport metadata attached to inbound messages.
 *
 * Each platform populates this with identity / ownership information about the
 * message author. Platform-specific extensions (e.g. Discord snowflakes) live
 * in the concrete subtype and are keyed under `InternalMessage.extensions.platform`.
 */
export interface PlatformTransportEnvelope {
  /** Platform-native author identifier (e.g. Discord snowflake, Slack member id). */
  readonly authorId: string;
  /** Whether the author is a bot / app on the platform. */
  readonly authorIsBot: boolean;
  /** Whether the author is this Shoggoth instance's own bot identity. */
  readonly isSelf: boolean;
  /** Whether the author is the configured operator / owner. */
  readonly isOwner: boolean;
}

// ---------------------------------------------------------------------------
// PlatformCapabilityDescriptor
// ---------------------------------------------------------------------------

/**
 * Platform capability descriptor.
 *
 * Re-exported from {@link MessagingAdapterCapabilities} which is already
 * platform-agnostic (keyed by a `platform` string, no platform-specific fields).
 * This alias exists for naming consistency with the other `Platform*` types.
 */
export type PlatformCapabilityDescriptor = MessagingAdapterCapabilities;

// ---------------------------------------------------------------------------
// PlatformRuntime
// ---------------------------------------------------------------------------

/**
 * Top-level runtime interface that a messaging platform provides.
 *
 * Captures the common shape of what a connected platform exposes to the rest
 * of the system: an event bus, outbound sending, streaming, capabilities, and
 * session-channel routing.
 */
export interface PlatformRuntime {
  /** Unique platform identifier (e.g. `"discord"`, `"slack"`). */
  readonly platformId: string;

  /** Gracefully disconnect from the platform. */
  stop(): Promise<void>;

  /** Agent-to-agent event bus for delivering inbound messages to session handlers. */
  readonly bus: AgentToAgentBus;

  /** Platform capability descriptor for feature negotiation. */
  readonly capabilities: PlatformCapabilityDescriptor;

  /** Send an outbound message through this platform. */
  readonly outbound: PlatformOutbound;

  /**
   * Obtain a streaming outbound handle for the given session, or `undefined`
   * if the session has no mapped channel on this platform.
   */
  streamingForSession(sessionId: string): PlatformStreamingOutbound | undefined;

  /**
   * Trigger a "typing" or equivalent presence indicator for the given session's
   * channel. Best-effort; errors should be swallowed.
   */
  notifyAgentTypingForSession(sessionId: string): Promise<void>;

  /**
   * Resolve the platform-native channel/conversation id used for outbound
   * delivery for a session. Returns `undefined` when no mapping exists.
   */
  resolveOutboundChannelIdForSession?(sessionId: string): string | undefined;
}
