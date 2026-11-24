import { splitDiscordMessage } from "./split-message";

/** Discord message body limit; success and error replies are sliced to this length. */
export { DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS } from "./split-message";

/**
 * Truncate a message body to the platform limit without landing mid-fence: the
 * first chunk from the message splitter closes any open code fence (and other
 * formatting) at the boundary instead of slicing through it.
 */
export function sliceDiscordPlatformMessageBody(text: string): string {
  return splitDiscordMessage(text)[0] ?? "";
}
