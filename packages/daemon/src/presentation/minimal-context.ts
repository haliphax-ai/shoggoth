import type { ChatMessage } from "@shoggoth/models";

export interface MinimalContextInput {
  readonly systemPrompt: string;
  readonly fullTranscript: readonly ChatMessage[];
  readonly tailMessages: number;
  readonly eventContext: string;
}

/**
 * Build a minimal message array for a lightweight model turn.
 * Returns [system, ...tail_of_transcript, event_context_user_message].
 */
export function buildMinimalContextMessages(input: MinimalContextInput): ChatMessage[] {
  const system: ChatMessage = { role: "system", content: input.systemPrompt };
  const tail = input.tailMessages > 0
    ? input.fullTranscript.slice(-input.tailMessages)
    : [];
  const eventMessage: ChatMessage = { role: "user", content: input.eventContext };
  return [system, ...tail, eventMessage];
}

/** Format event context for a global reaction turn. */
export function formatGlobalReactionEventContext(emoji: string, messageContent: string): string {
  const truncated = messageContent.length > 500 ? messageContent.slice(0, 500) + "\u2026" : messageContent;
  return `Operator reacted ${emoji} to your message: "${truncated}"`;
}

/** Format event context for an ad-hoc reaction legend turn. */
export function formatAdhocReactionEventContext(
  selectedEmoji: string,
  legend: readonly { emoji: string; label: string }[],
  messageContent: string,
): string {
  const truncated = messageContent.length > 500 ? messageContent.slice(0, 500) + "\u2026" : messageContent;
  const legendLines = legend.map((e) =>
    e.emoji === selectedEmoji ? `${e.emoji} ${e.label} \u2190 selected` : `${e.emoji} ${e.label}`
  );
  return [
    `Operator reacted ${selectedEmoji} to your message with reaction legend:`,
    ...legendLines,
    "",
    `Original message: "${truncated}"`,
  ].join("\n");
}
