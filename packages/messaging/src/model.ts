/**
 * Internal message model (platform-agnostic).
 */

export type MessageDirection = "inbound" | "outbound";

export interface MessageAttachment {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  /** Workspace-relative path to the downloaded file. Populated when attachment handling mode includes download. */
  readonly localPath?: string;
}

export interface MessageReaction {
  readonly emoji: string;
  readonly count: number;
}

export interface MessageExtensions {
  readonly attachments?: readonly MessageAttachment[];
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  readonly reactions?: readonly MessageReaction[];
  /**
   * Platform-keyed transport envelopes (e.g. `{ discord: { ... } }`).
   * Provides a uniform lookup path for multi-platform support.
   */
  readonly platform?: Record<string, import("./platform").PlatformTransportEnvelope>;
}

export interface InternalMessage {
  readonly id: string;
  readonly direction: MessageDirection;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly createdAt: string;
  readonly body: string;
  readonly extensions: MessageExtensions;
}

export interface CreateInboundMessageInput {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly createdAt: string;
  readonly body: string;
  readonly extensions?: MessageExtensions;
}

function createMessage(
  input: CreateInboundMessageInput | CreateOutboundMessageInput,
  direction: MessageDirection,
): InternalMessage {
  return {
    id: input.id,
    direction,
    sessionId: input.sessionId,
    agentId: input.agentId,
    userId: input.userId,
    createdAt: input.createdAt,
    body: input.body,
    extensions: input.extensions ?? {},
  };
}

export function createInboundMessage(input: CreateInboundMessageInput): InternalMessage {
  return createMessage(input, "inbound");
}

export interface CreateOutboundMessageInput {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly createdAt: string;
  readonly body: string;
  readonly extensions?: MessageExtensions;
}

export function createOutboundMessage(input: CreateOutboundMessageInput): InternalMessage {
  return createMessage(input, "outbound");
}
