/**
 * Renders a block of thinking text as a blockquote. The 💭 marker lands on
 * the block's first line only; continuation lines keep the blockquote bare.
 *
 * Shared by the daemon's streaming thinking renderer
 * (`daemon/src/messaging/thinking-output`) and the platform edge formatter
 * (`platform-discord/src/thinking-formatter`) so the two renderers cannot
 * drift apart.
 */
export function renderThinkingBlockquote(text: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? `> 💭 ${line}` : `> ${line}`))
    .join("\n");
}
