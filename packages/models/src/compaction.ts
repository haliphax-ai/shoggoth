import type { FailoverModelClient } from "./failover";
import type { ChatMessage } from "./types";

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

  const summarizerMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Summarize the following conversation excerpt for later context. Be concise; output summary text only.",
    },
    { role: "user", content: excerpt },
  ];

  const summaryOut = await client.complete({
    messages: summarizerMessages,
    maxOutputTokens: policy.summaryMaxOutputTokens,
    temperature: 0.2,
  });

  const summaryBlock: ChatMessage = {
    role: "assistant",
    content: `[Compacted context]\n${summaryOut.content.trim()}`,
  };

  return {
    compacted: true,
    messages: [...prefix, summaryBlock, ...tail],
  };
}
