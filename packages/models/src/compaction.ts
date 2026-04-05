import type { FailoverModelClient } from "./failover";
import type { ChatMessage, ModelInvocationParams } from "./types";

export interface CompactionPolicy {
  /** When total transcript characters exceed this, auto-compaction runs (unless only tail remains). */
  readonly maxContextChars: number;
  /** Non-system messages kept verbatim at the end after compaction. */
  readonly preserveRecentMessages: number;
  /** Optional cap for the summarization call. */
  readonly summaryMaxOutputTokens?: number;
}

export interface CompactTranscriptOptions {
  readonly force?: boolean;
  /** Merged into the summarization `complete()` call (defaults still apply for unset fields). */
  readonly modelInvocation?: ModelInvocationParams;
}

export interface CompactTranscriptResult {
  readonly compacted: boolean;
  readonly messages: ChatMessage[];
}

export function estimateTranscriptChars(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += (m.content ?? "").length;
  return n;
}

/** Whether automatic compaction should run before the next model call (session loop integration). */
export function shouldAutoCompact(
  messages: readonly ChatMessage[],
  policy: Pick<CompactionPolicy, "maxContextChars">,
): boolean {
  return estimateTranscriptChars(messages) > policy.maxContextChars;
}

function splitSystemPrefix(
  messages: readonly ChatMessage[],
): { prefix: ChatMessage[]; rest: ChatMessage[] } {
  const prefix: ChatMessage[] = [];
  let i = 0;
  while (i < messages.length && messages[i]!.role === "system") {
    prefix.push(messages[i]!);
    i++;
  }
  return { prefix, rest: messages.slice(i) };
}

const SUMMARY_TEMPLATE = `<summary-template>
# Compaction Summary

## Goal

## Constraints / Preferences

## Progress

### Done

### In Progress

### Blocked

## Key Decisions

## Next Steps

## Critical Context

## Opaque Identifiers
</summary-template>`;

/**
 * Extract the content of a <summary> block from a string, if present.
 * Returns the content between <summary> and </summary> tags, or null if not found.
 */
function extractSummaryBlock(content: string): string | null {
  const startTag = "<summary>";
  const endTag = "</summary>";
  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }
  return content.slice(startIdx + startTag.length, endIdx);
}

/**
 * Find the first assistant message in the transcript and extract its <summary> block if present.
 */
function findPreviousSummary(messages: readonly ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.role === "assistant" && typeof m.content === "string") {
      const summary = extractSummaryBlock(m.content);
      if (summary !== null) {
        return summary;
      }
    }
  }
  return null;
}

export async function compactTranscriptIfNeeded(
  messages: readonly ChatMessage[],
  policy: CompactionPolicy,
  client: FailoverModelClient,
  options: CompactTranscriptOptions,
): Promise<CompactTranscriptResult> {
  const total = estimateTranscriptChars(messages);
  const over = total > policy.maxContextChars;
  const shouldTry = options.force === true || over;

  if (!shouldTry) {
    return { compacted: false, messages: [...messages] };
  }

  const { prefix, rest } = splitSystemPrefix(messages);
  const preserve = Math.max(0, policy.preserveRecentMessages);
  if (rest.length <= preserve) {
    return { compacted: false, messages: [...messages] };
  }

  const tail = rest.slice(-preserve);
  const middle = rest.slice(0, -preserve);
  if (middle.length === 0) {
    return { compacted: false, messages: [...messages] };
  }

  const excerpt = middle
    .map((m) => `${m.role}: ${m.content ?? ""}`)
    .join("\n\n");

  const previousSummary = findPreviousSummary(messages);

  let systemContent: string;
  if (previousSummary !== null) {
    systemContent = `Summarize the following conversation excerpt for later context. Be concise; output summary text only. Preserve all opaque identifiers exactly as written (no shortening or reconstruction), including UUIDs, hashes, IDs, tokens, API keys, hostnames, IPs, ports, URLs, and file names. Merge this information with the previous summary; add/edit/move to-do items, include new key decisions and updated next steps, etc.

<previous-summary>
${previousSummary}
</previous-summary>`;
  } else {
    systemContent = `Summarize the following conversation excerpt for later context. Be concise; output summary text only. Preserve all opaque identifiers exactly as written (no shortening or reconstruction), including UUIDs, hashes, IDs, tokens, API keys, hostnames, IPs, ports, URLs, and file names.

${SUMMARY_TEMPLATE}`;
  }

  const userContent = `<conversation>
${excerpt}
</conversation>`;

  const summarizerMessages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const inv = options.modelInvocation ?? {};
  const summaryOut = await client.complete({
    messages: summarizerMessages,
    maxOutputTokens: inv.maxOutputTokens ?? policy.summaryMaxOutputTokens,
    temperature: inv.temperature ?? 0.2,
    thinking: inv.thinking,
    reasoningEffort: inv.reasoningEffort,
    requestExtras: inv.requestExtras,
  });

  const summaryBlock: ChatMessage = {
    role: "assistant",
    content: `<summary>
${summaryOut.content.trim()}
</summary>`,
  };

  return {
    compacted: true,
    messages: [...prefix, summaryBlock, ...tail],
  };
}