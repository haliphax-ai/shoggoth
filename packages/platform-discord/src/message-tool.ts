import {
  executeMessageToolAction,
  summarizeApiMessage,
  type MessageToolDeps,
  type AttachmentDownloadResult,
} from "@shoggoth/messaging";

export type DiscordMessageToolDeps = MessageToolDeps;
export { executeMessageToolAction as executeDiscordMessageToolAction };
export { summarizeApiMessage as summarizeDiscordApiMessage };
export type { AttachmentDownloadResult };
