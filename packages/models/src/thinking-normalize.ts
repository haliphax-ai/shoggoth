import type { ChatContentPart } from "./types";

type State = 'text' | 'buffering-tag' | 'in-thinking';

interface ProcessResult {
  thinking?: string;
  text?: string;
}

export class ThinkingStreamNormalizer {
  private state: State = 'text';
  private buffer: string = '';
  private thinkingContent: string = '';
  private textContent: string = '';
  private readonly MAX_BUFFER_SIZE = 11; // Length of "</thinking>"

  processChunk(chunk: string): ProcessResult {
    const result: ProcessResult = {};
    let i = 0;

    while (i < chunk.length) {
      const char = chunk[i];

      switch (this.state) {
        case 'text':
          if (char === '<') {
            this.state = 'buffering-tag';
            this.buffer = '<';
          } else {
            this.textContent += char;
          }
          i++;
          break;

        case 'buffering-tag':
          this.buffer += char;

          if (this.buffer === '<thinking>') {
            this.state = 'in-thinking';
            this.buffer = '';
          } else if (this.buffer === '</thinking>') {
            this.state = 'text';
            this.buffer = '';
            // Flush accumulated thinking content
            if (this.thinkingContent) {
              result.thinking = this.thinkingContent;
              this.thinkingContent = '';
            }
          } else if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
            // Buffer exceeded, not a tag we're looking for
            this.textContent += this.buffer;
            this.state = 'text';
            this.buffer = '';
          }
          i++;
          break;

        case 'in-thinking':
          if (char === '<') {
            this.state = 'buffering-tag';
            this.buffer = '<';
          } else {
            this.thinkingContent += char;
          }
          i++;
          break;
      }
    }

    if (this.textContent) {
      result.text = this.textContent;
      this.textContent = '';
    }

    return result;
  }

  flush(): ProcessResult {
    const result: ProcessResult = {};

    // Handle any remaining buffer content
    if (this.buffer) {
      if (this.state === 'in-thinking') {
        this.thinkingContent += this.buffer;
      } else {
        this.textContent += this.buffer;
      }
      this.buffer = '';
    }

    // Return any accumulated content
    if (this.thinkingContent) {
      result.thinking = this.thinkingContent;
      this.thinkingContent = '';
    }

    if (this.textContent) {
      result.text = this.textContent;
      this.textContent = '';
    }

    // Reset state
    this.state = 'text';

    return result;
  }
}

/**
 * Extracts thinking blocks from content that uses XML-style tags.
 * Returns an array of ChatContentPart if thinking tags are found,
 * otherwise returns the original string unchanged.
 */
export function extractXmlThinkingBlocks(
  content: string,
): string | ChatContentPart[] {
  const regex = /<thinking>([\s\S]*?)<\/thinking>/g;

  // Quick check: if no matches, return original string
  if (!regex.test(content)) {
    return content;
  }

  // Reset regex state for iteration
  regex.lastIndex = 0;

  const parts: ChatContentPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    // Add text before this thinking block
    const before = content.slice(lastIndex, match.index).trim();
    if (before) {
      parts.push({ type: "text", text: before });
    }

    // Add thinking block (skip if empty after trim)
    const thinkingText = match[1].trim();
    if (thinkingText) {
      parts.push({ type: "thinking", text: thinkingText });
    }

    lastIndex = regex.lastIndex;
  }

  // Add any remaining text after the last thinking block
  const after = content.slice(lastIndex).trim();
  if (after) {
    parts.push({ type: "text", text: after });
  }

  // If we only have one text part, return it as a string
  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }

  return parts;
}

/**
 * Normalizes thinking blocks based on the format specified in model capabilities.
 * - "native": Returns content unchanged (provider handles thinking natively)
 * - "xml-tags": Extracts thinking blocks from XML tags
 * - "none": Returns content unchanged (no thinking processing)
 */
export function normalizeThinkingBlocks(
  content: string,
  format: "native" | "xml-tags" | "none" | undefined,
): string | ChatContentPart[] {
  if (format !== "xml-tags") {
    return content;
  }

  return extractXmlThinkingBlocks(content);
}

/**
 * Strips `<thinking>...</thinking>` tags from a string, returning only the
 * non-thinking text. Useful for cleaning tool call arguments when the model
 * leaks thinking tags into structured output.
 */
export function stripXmlThinkingTags(content: string): string {
  return content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
}
