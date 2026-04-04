/**
 * Formats thinking blocks in Discord messages based on display mode.
 */

export type ThinkingDisplayMode = 'full' | 'indicator' | 'none';

interface FormattedThinking {
  thinking: string;
  response: string;
}

/**
 * Extract thinking and response content from a message body.
 * Assumes thinking is wrapped in <thinking>...</thinking> tags.
 */
function extractThinkingAndResponse(body: string): { thinking: string; response: string } {
  const thinkingMatch = body.match(/<thinking>([\s\S]*?)<\/thinking>/);
  if (!thinkingMatch) {
    return { thinking: '', response: body };
  }

  const thinking = thinkingMatch[1];
  const response = body.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
  return { thinking, response };
}

/**
 * Format thinking content as a Discord blockquote with 💭 prefix.
 */
function formatThinkingFull(thinking: string): string {
  const lines = thinking.split('\n');
  return lines.map(line => `> 💭 ${line}`).join('\n');
}

/**
 * Format thinking as a single indicator line.
 */
function formatThinkingIndicator(): string {
  return '> 💭 Thinking...';
}

/**
 * Format the message body based on thinking display mode.
 */
export function formatMessageWithThinking(
  body: string,
  mode: ThinkingDisplayMode,
): string {
  if (mode === 'none') {
    // Strip thinking entirely
    return body.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
  }

  const { thinking, response } = extractThinkingAndResponse(body);

  if (!thinking) {
    return body;
  }

  let formatted = '';

  if (mode === 'full') {
    formatted = formatThinkingFull(thinking);
    if (response) {
      formatted += '\n\n' + response;
    }
  } else if (mode === 'indicator') {
    formatted = formatThinkingIndicator();
    if (response) {
      formatted += '\n\n' + response;
    }
  }

  return formatted;
}

/**
 * Check if a chunk contains a thinking→response transition.
 * Returns true if the chunk has both thinking content and response content.
 */
export function hasThinkingTransition(chunk: string): boolean {
  const hasThinking = /<thinking>[\s\S]*?<\/thinking>/.test(chunk);
  const { thinking, response } = extractThinkingAndResponse(chunk);
  return hasThinking && thinking.length > 0 && response.length > 0;
}

/**
 * Format a chunk that may contain a thinking→response transition.
 * Ensures proper formatting with blockquote closure before response.
 */
export function formatChunkWithTransition(
  chunk: string,
  mode: ThinkingDisplayMode,
): string {
  if (mode === 'none') {
    return chunk.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
  }

  const { thinking, response } = extractThinkingAndResponse(chunk);

  if (!thinking) {
    return chunk;
  }

  let formatted = '';

  if (mode === 'full') {
    formatted = formatThinkingFull(thinking);
    if (response) {
      // Ensure proper transition: end blockquote, then response
      formatted += '\n\n' + response;
    }
  } else if (mode === 'indicator') {
    formatted = formatThinkingIndicator();
    if (response) {
      formatted += '\n\n' + response;
    }
  }

  return formatted;
}
