/** Discord message body limit; success and error replies are sliced to this length. */
export const DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS = 2000;

export function sliceDiscordPlatformMessageBody(text: string): string {
  return text.slice(0, DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS);
}
