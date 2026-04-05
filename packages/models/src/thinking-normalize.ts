import type { ChatContentPart } from "./types";

type State = 'text' | 'buffering-tag' | 'in-thinking';

interface ProcessResult {
  thinking?: string;
  text?: string;
}

/** Opening tags recognized as thinking block starts. */
const OPEN_TAGS = ['<thinking>', '<think>'];
/** Closing tags recognized as thinking block ends. */
const CLOSE_TAGS = ['</thinking>', '</think>'];
/** Max buffer needed to identify the longest tag. */
const MAX_TAG_LEN = Math.max(...OPEN_TAGS.map(t => t.length), ...CLOSE_TAGS.map(t => t.length));

function isOpenTag(buf: string): boolean {
  return OPEN_TAGS.includes(buf);
}

function isCloseTag(buf: string): boolean {
  return CLOSE_TAGS.includes(buf);
}

function couldBeTag(buf: string): boolean {
  return [...OPEN_TAGS, ...CLOSE_TAGS].some(tag => tag.startsWith(buf));
}

export class ThinkingStreamNormalizer {
  private state: State = 'text';
  private buffer: string = '';
  private thinkingContent: string = '';
  private textContent: string = '';

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

          if (isOpenTag(this.buffer)) {
            this.state = 'in-thinking';
            this.buffer = '';
          } else if (isCloseTag(this.buffer)) {
            this.state = 'text';
            this.buffer = '';
            if (this.thinkingContent) {
              result.thinking = this.thinkingContent;
              this.thinkingContent = '';
            }
          } else if (!couldBeTag(this.buffer) || this.buffer.length >= MAX_TAG_LEN) {
            // Not a prefix of any known tag, or exceeded max length
            if (this.state === 'buffering-tag') {
              this.textContent += this.buffer;
              this.state = 'text';
            }
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

    if (this.buffer) {
      if (this.state === 'in-thinking') {
        this.thinkingContent += this.buffer;
      } else {
        this.textContent += this.buffer;
      }
      this.buffer = '';
    }

    if (this.thinkingContent) {
      result.thinking = this.thinkingContent;
      this.thinkingContent = '';
    }

    if (this.textContent) {
      result.text = this.textContent;
      this.textContent = '';
    }

    this.state = 'text';

    return result;
  }
}

/** Regex matching both `<thinking>` and `<think>` tag variants. */
const THINKING_BLOCK_RE = /<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/g;

/**
 * Extracts thinking blocks from content that uses XML-style tags.
 * Recognizes both `<thinking>...</thinking>` and `<think>...</think>`.
 * Returns an array of ChatContentPart if thinking tags are found,
 * otherwise returns the original string unchanged.
 */
export function extractXmlThinkingBlocks(
  content: string,
): string | ChatContentPart[] {
  const regex = new RegExp(THINKING_BLOCK_RE.source, THINKING_BLOCK_RE.flags);

  if (!regex.test(content)) {
    return content;
  }

  regex.lastIndex = 0;

  const parts: ChatContentPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index).trim();
    if (before) {
      parts.push({ type: "text", text: before });
    }

    const thinkingText = match[1].trim();
    if (thinkingText) {
      parts.push({ type: "thinking", text: thinkingText });
    }

    lastIndex = regex.lastIndex;
  }

  const after = content.slice(lastIndex).trim();
  if (after) {
    parts.push({ type: "text", text: after });
  }

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
 * Strips thinking XML tags from a string, returning only the non-thinking text.
 * Recognizes both `<thinking>...</thinking>` and `<think>...</think>`.
 * Useful for cleaning tool call arguments when the model leaks thinking tags
 * into structured output.
 */
export function stripXmlThinkingTags(content: string): string {
  return content.replace(THINKING_BLOCK_RE, "").trim();
}
