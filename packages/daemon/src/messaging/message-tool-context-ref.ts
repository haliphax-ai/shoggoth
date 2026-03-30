import type { MessageToolPlatformSlice } from "@shoggoth/mcp-integration";
import type { MessagingAdapterCapabilities } from "@shoggoth/messaging";

export const messageToolContextRef: {
  current: {
    readonly slice: MessageToolPlatformSlice;
    execute: (sessionId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } | undefined;
} = { current: undefined };

export function messageToolSliceFromCapabilities(c: MessagingAdapterCapabilities): MessageToolPlatformSlice {
  const x = c.extensions;
  return {
    attachments: x.attachments,
    messageEdit: x.messageEdit,
    messageDelete: x.messageDelete,
    threadCreate: x.threadCreate,
    threadDelete: x.threadDelete,
    replies: x.replies,
    messageGet: x.messageGet,
  };
}
