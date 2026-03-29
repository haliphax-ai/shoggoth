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

export function createInboundMessage(input: CreateInboundMessageInput): InternalMessage {
  return {
    id: input.id,
    direction: "inbound",
    sessionId: input.sessionId,
    agentId: input.agentId,
    userId: input.userId,
    createdAt: input.createdAt,
    body: input.body,
    extensions: input.extensions ?? {},
  };
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
  return {
    id: input.id,
    direction: "outbound",
    sessionId: input.sessionId,
    agentId: input.agentId,
    userId: input.userId,
    createdAt: input.createdAt,
    body: input.body,
    extensions: input.extensions ?? {},
  };
}
