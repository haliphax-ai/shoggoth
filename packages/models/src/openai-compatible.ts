import { ModelHttpError } from "./errors";
import type {
  ChatMessage,
  ChatToolCall,
  ModelCompleteInput,
  ModelInvocationParams,
  ModelProvider,
  ModelToolCompleteInput,
  ModelToolCompleteOutput,
  ModelUsage,
} from "./types";

/** Extract usage metadata from an OpenAI chat completions response. */
function extractOpenAIUsage(json: unknown): ModelUsage | undefined {
  const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return undefined;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
}

export type FetchLike = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAICompatibleProviderOptions {
  readonly id: string;
  /** Base URL including `/v1` suffix, e.g. `https://api.openai.com/v1` */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetchImpl?: FetchLike;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function applyOpenAICompatibleRequestExtensions(
  body: Record<string, unknown>,
  input: Pick<ModelInvocationParams, "reasoningEffort" | "requestExtras">,
): void {
  const effort = input.reasoningEffort?.trim();
  if (effort) body.reasoning_effort = effort;
  const x = input.requestExtras;
  if (x && typeof x === "object") {
    Object.assign(body, x);
  }
}

function serializeChatMessage(m: ChatMessage): Record<string, unknown> {
  const o: Record<string, unknown> = { role: m.role };
  if (m.name) o.name = m.name;
  if (m.toolCallId) o.tool_call_id = m.toolCallId;
  if (m.toolCalls?.length) {
    o.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  if (m.content !== undefined && m.content !== null) {
    o.content = m.content;
  } else if (m.toolCalls?.length) {
    o.content = null;
  } else {
    o.content = "";
  }
  return o;
}

type ToolCallPartial = { id: string; name: string; arguments: string };

function applyToolCallDeltas(map: Map<number, ToolCallPartial>, deltas: unknown): void {
  if (!Array.isArray(deltas)) return;
  for (const item of deltas) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const idx = typeof o.index === "number" ? o.index : 0;
    let cur = map.get(idx);
    if (!cur) {
      cur = { id: "", name: "", arguments: "" };
      map.set(idx, cur);
    }
    if (typeof o.id === "string" && o.id.length > 0) cur.id = o.id;
    const fn = o.function;
    if (fn && typeof fn === "object" && fn !== null) {
      const f = fn as Record<string, unknown>;
      if (typeof f.name === "string" && f.name.length > 0) cur.name = f.name;
      if (typeof f.arguments === "string") cur.arguments += f.arguments;
    }
  }
}

function finalizeToolCalls(map: Map<number, ToolCallPartial>): ChatToolCall[] {
  const keys = [...map.keys()].sort((a, b) => a - b);
  const out: ChatToolCall[] = [];
  for (const k of keys) {
    const t = map.get(k)!;
    if (t.id && t.name) {
      out.push({ id: t.id, name: t.name, arguments: t.arguments || "{}" });
    }
  }
  return out;
}

interface ConsumeStreamOptions {
  readonly accumulateTools: boolean;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
}

async function consumeOpenAIChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeStreamOptions,
): Promise<{ content: string | null; toolCalls: ChatToolCall[]; usage?: ModelUsage }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = "";
  let sawValidChoice = false;
  let content: string | null = null;
  let usage: ModelUsage | undefined;
  const toolPartials = new Map<number, ToolCallPartial>();

  const processDataPayload = (data: string) => {
    if (data === "[DONE]") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      throw new ModelHttpError(502, "malformed SSE chunk", data.slice(0, 200));
    }

    // Capture usage from the final chunk (sent when stream_options.include_usage is true).
    const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    if (u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
      usage = { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
    }

    const choices = (json as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const ch0 = choices[0];
    if (!ch0 || typeof ch0 !== "object") return;
    sawValidChoice = true;
    const delta = (ch0 as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object" || delta === null) return;
    const d = delta as { content?: unknown; tool_calls?: unknown };

    if (typeof d.content === "string" && d.content.length > 0) {
      const prev = content ?? "";
      const next = prev + d.content;
      content = next;
      options.onTextDelta?.(d.content, next);
    }

    if (options.accumulateTools && d.tool_calls !== undefined) {
      applyToolCallDeltas(toolPartials, d.tool_calls);
    }
  };

  const flushLine = (line: string) => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trimStart();
    if (payload === "") return;
    processDataPayload(payload);
  };

  while (true) {
    const { done, value } = await reader.read();
    const chunkText = done ? decoder.decode() : decoder.decode(value, { stream: true });
    lineBuf += chunkText;
    let nl: number;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      flushLine(line);
    }
    if (done) break;
  }
  if (lineBuf.length > 0) flushLine(lineBuf);

  if (!sawValidChoice) {
    throw new ModelHttpError(
      502,
      "stream ended without valid choices",
      lineBuf.slice(0, 200),
    );
  }

  return {
    content,
    toolCalls: options.accumulateTools ? finalizeToolCalls(toolPartials) : [],
    usage,
  };
}

export function createOpenAICompatibleProvider(
  options: OpenAICompatibleProviderOptions,
): ModelProvider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const base = trimSlash(options.baseUrl);
  const id = options.id;

  return {
    id,
    async complete(input: ModelCompleteInput) {
      const url = `${base}/chat/completions`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

      const body: Record<string, unknown> = {
        model: input.model,
        messages: input.messages.map((m) => serializeChatMessage(m)),
        max_tokens: input.maxOutputTokens,
        temperature: input.temperature,
      };
      if (input.stream === true) {
        body.stream = true;
        body.stream_options = { include_usage: true };
      }
      applyOpenAICompatibleRequestExtensions(body, input);

      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (input.stream === true) {
        if (!res.ok) {
          const errText = await res.text();
          throw new ModelHttpError(
            res.status,
            res.statusText || `HTTP ${res.status}`,
            errText.slice(0, 500),
          );
        }
        if (!res.body) {
          throw new ModelHttpError(502, "missing response body for stream", undefined);
        }
        const { content: streamed, toolCalls, usage } = await consumeOpenAIChatCompletionStream(res.body, {
          accumulateTools: false,
          onTextDelta: input.onTextDelta,
        });
        if (toolCalls.length > 0) {
          throw new ModelHttpError(
            502,
            "unexpected tool_calls in non-tool chat completion stream",
            "",
          );
        }
        if (streamed === null) {
          throw new ModelHttpError(502, "missing streamed assistant content", "");
        }
        return { content: streamed, usage };
      }

      const text = await res.text();
      if (!res.ok) {
        throw new ModelHttpError(
          res.status,
          res.statusText || `HTTP ${res.status}`,
          text.slice(0, 500),
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelHttpError(502, "invalid JSON from model endpoint", text.slice(0, 200));
      }

      const choices = (json as { choices?: unknown }).choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const message =
        first && typeof first === "object" && first !== null && "message" in first
          ? (first as { message?: { content?: unknown } }).message
          : undefined;
      const content =
        message && typeof message.content === "string"
          ? message.content
          : message && message.content === null
            ? ""
            : undefined;
      if (typeof content !== "string") {
        throw new ModelHttpError(502, "missing choices[0].message.content", text.slice(0, 200));
      }

      return { content, usage: extractOpenAIUsage(json) };
    },

    async completeWithTools(input: ModelToolCompleteInput): Promise<ModelToolCompleteOutput> {
      const url = `${base}/chat/completions`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

      const body: Record<string, unknown> = {
        model: input.model,
        messages: input.messages.map((m) => serializeChatMessage(m)),
        tools: input.tools,
        tool_choice: "auto" as const,
        max_tokens: input.maxOutputTokens,
        temperature: input.temperature,
      };
      if (input.stream === true) {
        body.stream = true;
        body.stream_options = { include_usage: true };
      }
      applyOpenAICompatibleRequestExtensions(body, input);

      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (input.stream === true) {
        if (!res.ok) {
          const errText = await res.text();
          throw new ModelHttpError(
            res.status,
            res.statusText || `HTTP ${res.status}`,
            errText.slice(0, 500),
          );
        }
        if (!res.body) {
          throw new ModelHttpError(502, "missing response body for stream", undefined);
        }
        const { content, toolCalls, usage } = await consumeOpenAIChatCompletionStream(res.body, {
          accumulateTools: true,
          onTextDelta: input.onTextDelta,
        });

        if (toolCalls.length === 0 && (content === null || content === "")) {
          throw new ModelHttpError(502, "missing assistant content and tool_calls", "");
        }

        return { content, toolCalls, usage };
      }

      const text = await res.text();
      if (!res.ok) {
        throw new ModelHttpError(
          res.status,
          res.statusText || `HTTP ${res.status}`,
          text.slice(0, 500),
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelHttpError(502, "invalid JSON from model endpoint", text.slice(0, 200));
      }

      const choices = (json as { choices?: unknown }).choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const message =
        first && typeof first === "object" && first !== null && "message" in first
          ? (first as { message?: Record<string, unknown> }).message
          : undefined;

      let content: string | null = null;
      if (message && typeof message.content === "string") {
        content = message.content;
      } else if (message && message.content === null) {
        content = null;
      }

      const toolCallsRaw = message?.tool_calls;
      const toolCalls: { id: string; name: string; arguments: string }[] = [];
      if (Array.isArray(toolCallsRaw)) {
        for (const tc of toolCallsRaw) {
          if (!tc || typeof tc !== "object") continue;
          const id = typeof (tc as { id?: unknown }).id === "string" ? (tc as { id: string }).id : "";
          const fn = (tc as { function?: unknown }).function;
          if (!fn || typeof fn !== "object") continue;
          const name =
            typeof (fn as { name?: unknown }).name === "string" ? (fn as { name: string }).name : "";
          const args =
            typeof (fn as { arguments?: unknown }).arguments === "string"
              ? (fn as { arguments: string }).arguments
              : "{}";
          if (id && name) toolCalls.push({ id, name, arguments: args });
        }
      }

      if (toolCalls.length === 0 && (content === null || content === "")) {
        throw new ModelHttpError(
          502,
          "missing assistant content and tool_calls",
          text.slice(0, 200),
        );
      }

      return { content, toolCalls, usage: extractOpenAIUsage(json) };
    },
  };
}
