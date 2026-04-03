import { ModelHttpError } from "./errors";
import { anthropicImageBlockCodec } from "./image-codec";
import { getResilienceGate, parseRateLimitHeaders } from "./resilience";
import type {
  ChatContentPart,
  ChatMessage,
  ChatToolCall,
  ModelCompleteInput,
  ModelInvocationParams,
  ModelProvider,
  ModelStreamTextDeltaCallback,
  ModelToolCompleteInput,
  ModelToolCompleteOutput,
  ModelUsage,
  OpenAIToolFunctionDefinition,
} from "./types";
import type { FetchLike } from "./openai-compatible";

export type AnthropicMessagesAuthStyle = "x-api-key" | "bearer";

/** Extract usage metadata from an Anthropic Messages API response. */
function extractAnthropicUsage(json: unknown): ModelUsage | undefined {
  const u = (json as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  if (!u || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return undefined;
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
}

export interface AnthropicMessagesProviderOptions {
  readonly id: string;
  /** API origin only (no path); requests go to `{origin}/v1/messages`. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Default `2023-06-01`. */
  readonly anthropicVersion?: string;
  readonly fetchImpl?: FetchLike;
  /** Default `x-api-key`; use `bearer` for gateways that expect `Authorization: Bearer`. */
  readonly auth?: AnthropicMessagesAuthStyle;
}

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_BUDGET_TOKENS = 10_000;

function applyAnthropicMessagesRequestExtensions(
  body: Record<string, unknown>,
  input: Pick<ModelInvocationParams, "thinking" | "requestExtras">,
): void {
  const th = input.thinking;
  if (th?.enabled === true) {
    body.thinking = {
      type: "enabled",
      budget_tokens: th.budgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS,
    };
  } else if (th?.enabled === false) {
    body.thinking = { type: "disabled" };
  }
  const x = input.requestExtras;
  if (x && typeof x === "object") {
    Object.assign(body, x);
  }
}
/** Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$` (dots/colons from OpenAI/MCP are invalid). */
const ANTHROPIC_TOOL_NAME_MAX = 64;

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function sanitizeAnthropicToolNameBase(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (s.length === 0) s = "tool";
  return s.length > ANTHROPIC_TOOL_NAME_MAX ? s.slice(0, ANTHROPIC_TOOL_NAME_MAX) : s;
}

/**
 * OpenAI tool name → Anthropic-safe name for this request. Resolves collisions when two names
 * sanitize to the same string (e.g. `a.b` and `a_b`).
 */
export function buildOpenAiToAnthropicToolNameMap(
  tools: readonly OpenAIToolFunctionDefinition[],
): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const t of tools) {
    const orig = t.function.name;
    const base = sanitizeAnthropicToolNameBase(orig);
    let candidate = base;
    let i = 0;
    while (used.has(candidate)) {
      i += 1;
      const suf = `_${i}`;
      const maxBase = Math.max(1, ANTHROPIC_TOOL_NAME_MAX - suf.length);
      const trimmedBase = base.slice(0, maxBase);
      candidate = (trimmedBase + suf).slice(0, ANTHROPIC_TOOL_NAME_MAX);
    }
    used.add(candidate);
    map.set(orig, candidate);
  }
  return map;
}

function invertStringMap(m: ReadonlyMap<string, string>): Map<string, string> {
  const inv = new Map<string, string>();
  for (const [k, v] of m) inv.set(v, k);
  return inv;
}

function normalizeAnthropicInputSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const p =
    parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? (parameters as Record<string, unknown>)
      : {};
  if (p.type === "object") {
    return p;
  }
  const props =
    typeof p.properties === "object" && p.properties !== null && !Array.isArray(p.properties)
      ? (p.properties as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = { type: "object", properties: props };
  if (Array.isArray(p.required)) {
    out.required = p.required;
  }
  return out;
}

/**
 * Anthropic-compatible gateways often register models as `namespace/model` while the Messages API
 * rejects slashes in `model`. Strip the first path segment (everything through the first `/`).
 */
export function normalizeAnthropicWireModelId(model: string): string {
  const i = model.indexOf("/");
  if (i < 0) return model;
  return model.slice(i + 1);
}

/** Normalize config `baseUrl` to origin (scheme + host[:port]) for `{origin}/v1/messages`. */
export function normalizeAnthropicMessagesOrigin(raw: string): string {
  const t = raw.trim();
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return trimSlash(t.replace(/\/v1\/?$/, ""));
  }
}

function buildAuthHeaders(
  apiKey: string | undefined,
  anthropicVersion: string,
  auth: AnthropicMessagesAuthStyle,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": anthropicVersion,
  };
  if (apiKey) {
    if (auth === "bearer") {
      headers.authorization = `Bearer ${apiKey}`;
    } else {
      headers["x-api-key"] = apiKey;
    }
  }
  return headers;
}

function mapOpenAIToolsToAnthropic(
  tools: readonly OpenAIToolFunctionDefinition[],
  openAiToAnthropicName: ReadonlyMap<string, string>,
): unknown[] {
  return tools.map((t) => {
    const anthropicName =
      openAiToAnthropicName.get(t.function.name) ?? sanitizeAnthropicToolNameBase(t.function.name);
    return {
      name: anthropicName,
      ...(t.function.description !== undefined ? { description: t.function.description } : {}),
      input_schema: normalizeAnthropicInputSchema(t.function.parameters),
    };
  });
}


function serializeAnthropicContentParts(parts: ChatContentPart[]): unknown[] {
  return parts.map((p) => {
    if (p.type === "text") {
      return { type: "text", text: p.text };
    }
    // ImageBlock — use Anthropic codec
    return anthropicImageBlockCodec.encode(p);
  });
}

/**
 * Collapse `ChatMessage` into Anthropic `system` + `messages`.
 * @throws ModelHttpError 502 on invalid tool `arguments` JSON when mapping assistant tool_calls.
 * @param openAiToAnthropicToolName When set, rewrites assistant `tool_use` names to match the Anthropic `tools` list.
 */
export function mapChatMessagesToAnthropicPayload(
  messages: readonly ChatMessage[],
  openAiToAnthropicToolName?: ReadonlyMap<string, string>,
): {
  system?: string;
  messages: unknown[];
} {
  const systemParts: string[] = [];
  const out: unknown[] = [];
  let i = 0;

  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "system") {
      if (m.content != null && String(m.content).length > 0) {
        systemParts.push(String(m.content));
      }
      i += 1;
      continue;
    }

    if (m.role === "tool") {
      const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
      while (i < messages.length && messages[i]!.role === "tool") {
        const tm = messages[i]!;
        toolResults.push({
          type: "tool_result",
          tool_use_id: tm.toolCallId ?? "",
          content: tm.content != null ? String(tm.content) : "",
        });
        i += 1;
      }
      out.push({ role: "user", content: toolResults });
      continue;
    }

    if (m.role === "user") {
      if (Array.isArray(m.content)) {
        out.push({ role: "user", content: serializeAnthropicContentParts(m.content) });
      } else {
        out.push({ role: "user", content: m.content != null ? String(m.content) : "" });
      }
      i += 1;
      continue;
    }

    if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text") {
            blocks.push({ type: "text", text: p.text });
          }
          // assistant messages: only text blocks (no images)
        }
      } else {
        const hasText = m.content != null && String(m.content).length > 0;
        if (hasText) {
          blocks.push({ type: "text", text: String(m.content) });
        }
      }
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          let input: unknown;
          try {
            input = tc.arguments.trim() ? JSON.parse(tc.arguments) : {};
          } catch {
            throw new ModelHttpError(
              502,
              "invalid tool call arguments JSON for Anthropic mapping",
              tc.arguments.slice(0, 200),
            );
          }
          const anthropicToolName =
            openAiToAnthropicToolName?.get(tc.name) ?? sanitizeAnthropicToolNameBase(tc.name);
          blocks.push({ type: "tool_use", id: tc.id, name: anthropicToolName, input });
        }
      }
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
      }
      out.push({ role: "assistant", content: blocks });
      i += 1;
      continue;
    }

    i += 1;
  }

  const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  return { system, messages: out };
}

function parseAnthropicErrorBody(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; type?: string } };
    const msg = j.error?.message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  } catch {
    // ignore
  }
  return text.slice(0, 500);
}

function contentBlocksToModelOutput(
  content: unknown,
  anthropicToOpenAiToolName?: ReadonlyMap<string, string>,
): { text: string | null; toolCalls: ChatToolCall[] } {
  if (!Array.isArray(content)) {
    throw new ModelHttpError(502, "Anthropic response missing content array", String(content).slice(0, 200));
  }

  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (type === "tool_use") {
      const id = typeof b.id === "string" ? b.id : "";
      const name = typeof b.name === "string" ? b.name : "";
      let argsStr: string;
      try {
        argsStr = JSON.stringify(b.input ?? {});
      } catch {
        throw new ModelHttpError(502, "tool_use input not JSON-serializable", "");
      }
      if (id && name) {
        const openAiName = anthropicToOpenAiToolName?.get(name) ?? name;
        toolCalls.push({ id, name: openAiName, arguments: argsStr });
      }
    }
  }

  const joined = textParts.join("");
  const text = joined.length > 0 ? joined : null;
  return { text, toolCalls };
}

type AnthropicBlockState =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; inputJson: string; finalized: boolean };

export interface ConsumeAnthropicMessagesStreamOptions {
  readonly accumulateTools: boolean;
  readonly onTextDelta?: ModelStreamTextDeltaCallback;
  /** Map Anthropic-safe tool names back to OpenAI/MCP names (e.g. `builtin_read` → `builtin-read`). */
  readonly anthropicToOpenAiToolName?: ReadonlyMap<string, string>;
}

/**
 * Incrementally parse Anthropic Messages SSE: frames separated by blank lines (`event:` / `data:` lines;
 * not OpenAI chat.completion SSE). Multiple `data:` lines in one frame are joined per the SSE spec; if the
 * join is not valid JSON, each `data:` line is parsed separately (tolerates streams without blank lines).
 * `onTextDelta(delta, accumulated)` matches OpenAI-compatible streaming.
 */
export async function consumeAnthropicMessagesStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeAnthropicMessagesStreamOptions,
): Promise<{ content: string | null; toolCalls: ChatToolCall[]; usage?: ModelUsage }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = "";
  const eventLines: string[] = [];
  let sawMessageStart = false;
  let sawMessageStop = false;
  /** Observed tool_use while `accumulateTools` is false (`complete` streaming). */
  let forbiddenToolUse = false;
  let accumulatedAssistantText = "";
  let usageInputTokens: number | undefined;
  let usageOutputTokens: number | undefined;
  const blocks = new Map<number, AnthropicBlockState>();
  const toolCallsByIndex: { index: number; call: ChatToolCall }[] = [];

  const finalizeToolBlock = (index: number, state: Extract<AnthropicBlockState, { kind: "tool_use" }>) => {
    if (state.finalized) return;
    let parsed: unknown;
    try {
      const s = state.inputJson.trim();
      parsed = s ? JSON.parse(s) : {};
    } catch {
      throw new ModelHttpError(
        502,
        "invalid tool input JSON from Anthropic stream",
        state.inputJson.slice(0, 200),
      );
    }
    let argsStr: string;
    try {
      argsStr = JSON.stringify(parsed ?? {});
    } catch {
      throw new ModelHttpError(502, "tool_use streamed input not JSON-serializable", "");
    }
    if (state.id && state.name) {
      const openAiName = options.anthropicToOpenAiToolName?.get(state.name) ?? state.name;
      toolCallsByIndex.push({ index, call: { id: state.id, name: openAiName, arguments: argsStr } });
    }
    state.finalized = true;
  };

  const handleDataPayload = (raw: string) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ModelHttpError(502, "malformed Anthropic SSE data JSON", raw.slice(0, 200));
    }
    if (!json || typeof json !== "object") return;
    const o = json as Record<string, unknown>;
    const t = o.type;

    if (t === "message_start") {
      sawMessageStart = true;
      // Capture input token usage from message_start event.
      const msg = o.message as Record<string, unknown> | undefined;
      const u = msg?.usage as { input_tokens?: number } | undefined;
      if (u && typeof u.input_tokens === "number") {
        usageInputTokens = u.input_tokens;
      }
      return;
    }
    if (t === "ping" || t === "message_delta") {
      // Capture output token usage from message_delta event.
      if (t === "message_delta") {
        const u = o.usage as { output_tokens?: number } | undefined;
        if (u && typeof u.output_tokens === "number") {
          usageOutputTokens = u.output_tokens;
        }
      }
      return;
    }
    if (t === "error") {
      const err = o.error as Record<string, unknown> | undefined;
      const msg =
        err && typeof err.message === "string" && err.message.length > 0
          ? err.message
          : "Anthropic stream error";
      throw new ModelHttpError(502, msg, raw.slice(0, 500));
    }
    if (t === "message_stop") {
      sawMessageStop = true;
      return;
    }

    if (t === "content_block_start") {
      const index = typeof o.index === "number" ? o.index : 0;
      const cb = o.content_block as Record<string, unknown> | undefined;
      const blockType = cb?.type;
      if (blockType === "text") {
        blocks.set(index, { kind: "text", text: "" });
      } else if (blockType === "tool_use") {
        if (!options.accumulateTools) {
          forbiddenToolUse = true;
        } else if (cb) {
          const id = typeof cb.id === "string" ? cb.id : "";
          const name = typeof cb.name === "string" ? cb.name : "";
          blocks.set(index, { kind: "tool_use", id, name, inputJson: "", finalized: false });
        }
      }
      return;
    }

    if (t === "content_block_delta") {
      const index = typeof o.index === "number" ? o.index : 0;
      const delta = o.delta as Record<string, unknown> | undefined;
      if (!delta) return;
      const dt = delta.type;

      if (dt === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        const d = delta.text;
        let st = blocks.get(index);
        if (!st || st.kind !== "text") {
          st = { kind: "text", text: "" };
          blocks.set(index, st);
        }
        if (st.kind === "text") {
          st.text += d;
          accumulatedAssistantText += d;
          options.onTextDelta?.(d, accumulatedAssistantText);
        }
        return;
      }

      if (dt === "input_json_delta") {
        if (!options.accumulateTools) return;
        const partial = typeof delta.partial_json === "string" ? delta.partial_json : "";
        let st = blocks.get(index);
        if (!st || st.kind !== "tool_use") {
          st = { kind: "tool_use", id: "", name: "", inputJson: "", finalized: false };
          blocks.set(index, st);
        }
        if (st.kind === "tool_use") {
          st.inputJson += partial;
        }
      }
      return;
    }

    if (t === "content_block_stop") {
      const index = typeof o.index === "number" ? o.index : 0;
      const st = blocks.get(index);
      if (st?.kind === "tool_use" && options.accumulateTools) {
        finalizeToolBlock(index, st);
      }
      return;
    }

    // Unknown event types: ignore (Anthropic may add new ones).
  };

  const flushSseEvent = (): void => {
    if (eventLines.length === 0) return;
    const dataParts: string[] = [];
    for (const raw of eventLines) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("data:")) {
        dataParts.push(line.slice(5).trimStart());
      }
    }
    eventLines.length = 0;
    if (dataParts.length === 0) return;
    if (dataParts.length === 1) {
      const one = dataParts[0]!;
      if (one.trim()) handleDataPayload(one);
      return;
    }
    const joined = dataParts.join("\n");
    if (!joined.trim()) return;
    try {
      JSON.parse(joined);
      handleDataPayload(joined);
    } catch {
      for (const d of dataParts) {
        if (d.trim()) handleDataPayload(d);
      }
    }
  };

  const flushLine = (line: string): void => {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "") {
      flushSseEvent();
      return;
    }
    if (trimmed.startsWith(":")) return;
    eventLines.push(trimmed);
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
  flushSseEvent();

  if (!sawMessageStart) {
    throw new ModelHttpError(502, "Anthropic stream ended without message_start", lineBuf.slice(0, 200));
  }
  if (!sawMessageStop) {
    throw new ModelHttpError(502, "Anthropic stream ended without message_stop", lineBuf.slice(0, 200));
  }
  if (forbiddenToolUse) {
    throw new ModelHttpError(
      502,
      "unexpected tool_use in non-tool Anthropic message stream",
      "",
    );
  }

  for (const [idx, st] of blocks) {
    if (st.kind === "tool_use" && options.accumulateTools && !st.finalized) {
      finalizeToolBlock(idx, st);
    }
  }

  const sortedIndices = [...blocks.keys()].sort((a, b) => a - b);
  const textParts: string[] = [];
  for (const idx of sortedIndices) {
    const st = blocks.get(idx);
    if (st?.kind === "text" && st.text.length > 0) textParts.push(st.text);
  }
  const joinedText = textParts.join("");
  const content = joinedText.length > 0 ? joinedText : null;

  toolCallsByIndex.sort((a, b) => a.index - b.index);
  const toolCalls = toolCallsByIndex.map((x) => x.call);

  const usage: ModelUsage | undefined =
    typeof usageInputTokens === "number" && typeof usageOutputTokens === "number"
      ? { inputTokens: usageInputTokens, outputTokens: usageOutputTokens }
      : undefined;

  return { content, toolCalls, usage };
}

function headersToRecord(h: Headers): Record<string, string | undefined> {
  const rec: Record<string, string | undefined> = {};
  h.forEach((v, k) => { rec[k.toLowerCase()] = v; });
  return rec;
}

export function createAnthropicMessagesProvider(
  options: AnthropicMessagesProviderOptions,
): ModelProvider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const origin = normalizeAnthropicMessagesOrigin(options.baseUrl);
  const url = `${trimSlash(origin)}/v1/messages`;
  const id = options.id;
  const anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  const auth: AnthropicMessagesAuthStyle = options.auth ?? "x-api-key";

  async function resilientFetch(targetUrl: string, init: RequestInit): Promise<Response> {
    try {
      const gate = getResilienceGate();
      return await gate.executeWithResilience(id, async () => {
        const res = await fetchImpl(targetUrl, init);
        try {
          const parsed = parseRateLimitHeaders(id, headersToRecord(res.headers), "anthropic");
          gate.getOrCreateManager(id).updateCapacity(parsed);
        } catch { /* ignore header parse errors */ }
        if (!res.ok) {
          const errText = await res.text();
          throw new ModelHttpError(
            res.status,
            res.statusText || `HTTP ${res.status}`,
            parseAnthropicErrorBody(errText),
          );
        }
        return res;
      });
    } catch (err: unknown) {
      if (err instanceof ModelHttpError) throw err;
      return fetchImpl(targetUrl, init);
    }
  }

  return {
    id,

    async complete(input: ModelCompleteInput) {
      const headers = buildAuthHeaders(options.apiKey, anthropicVersion, auth);
      const { system, messages: anthropicMessages } = mapChatMessagesToAnthropicPayload(
        input.messages,
      );
      const wireModel = normalizeAnthropicWireModelId(input.model);

      const body: Record<string, unknown> = {
        model: wireModel,
        max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        messages: anthropicMessages,
        stream: input.stream === true,
        temperature: input.temperature,
      };
      if (system !== undefined) body.system = system;
      applyAnthropicMessagesRequestExtensions(body, input);

      const res = await resilientFetch(url, {
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
            parseAnthropicErrorBody(errText),
          );
        }
        if (!res.body) {
          throw new ModelHttpError(502, "missing response body for Anthropic stream", undefined);
        }
        const { content: streamed, toolCalls, usage } = await consumeAnthropicMessagesStream(res.body, {
          accumulateTools: false,
          onTextDelta: input.onTextDelta,
        });
        if (toolCalls.length > 0) {
          throw new ModelHttpError(502, "unexpected tool_use in non-tool Anthropic message stream", "");
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
          parseAnthropicErrorBody(text),
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelHttpError(502, "invalid JSON from Anthropic Messages endpoint", text.slice(0, 200));
      }

      const content = (json as { content?: unknown }).content;
      const { text: outText, toolCalls } = contentBlocksToModelOutput(content);
      if (toolCalls.length > 0) {
        throw new ModelHttpError(
          502,
          "unexpected tool_use blocks in complete() response; use completeWithTools",
          text.slice(0, 200),
        );
      }
      if (outText === null) {
        throw new ModelHttpError(502, "missing assistant text in Anthropic response", text.slice(0, 200));
      }
      return { content: outText, usage: extractAnthropicUsage(json) };
    },

    async completeWithTools(input: ModelToolCompleteInput): Promise<ModelToolCompleteOutput> {
      const headers = buildAuthHeaders(options.apiKey, anthropicVersion, auth);
      const openAiToAnthropic = buildOpenAiToAnthropicToolNameMap(input.tools);
      const anthropicToOpenAi = invertStringMap(openAiToAnthropic);
      const { system, messages: anthropicMessages } = mapChatMessagesToAnthropicPayload(
        input.messages,
        openAiToAnthropic,
      );

      if (!input.model) {
        throw new Error("Anthropic Messages completeWithTools requires input.model");
      }

      const wireModel = normalizeAnthropicWireModelId(input.model);
      const anthropicTools = mapOpenAIToolsToAnthropic(input.tools, openAiToAnthropic);
      const body: Record<string, unknown> = {
        model: wireModel,
        max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        messages: anthropicMessages,
        stream: input.stream === true,
        temperature: input.temperature,
      };
      if (system !== undefined) body.system = system;
      /** Anthropic and some compatible gateways reject `tool_choice` when `tools` is empty or absent. */
      if (anthropicTools.length > 0) {
        body.tools = anthropicTools;
        body.tool_choice = { type: "auto" };
      }
      applyAnthropicMessagesRequestExtensions(body, input);

      const res = await resilientFetch(url, {
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
            parseAnthropicErrorBody(errText),
          );
        }
        if (!res.body) {
          throw new ModelHttpError(502, "missing response body for Anthropic stream", undefined);
        }
        const { content: outText, toolCalls, usage } = await consumeAnthropicMessagesStream(res.body, {
          accumulateTools: true,
          onTextDelta: input.onTextDelta,
          anthropicToOpenAiToolName: anthropicToOpenAi,
        });

        if (toolCalls.length === 0 && (outText === null || outText === "")) {
          throw new ModelHttpError(502, "missing assistant content and tool_use blocks", "");
        }

        return { content: outText, toolCalls, usage };
      }

      const text = await res.text();
      if (!res.ok) {
        throw new ModelHttpError(
          res.status,
          res.statusText || `HTTP ${res.status}`,
          parseAnthropicErrorBody(text),
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelHttpError(502, "invalid JSON from Anthropic Messages endpoint", text.slice(0, 200));
      }

      const content = (json as { content?: unknown }).content;
      const { text: outText, toolCalls } = contentBlocksToModelOutput(content, anthropicToOpenAi);

      if (toolCalls.length === 0 && (outText === null || outText === "")) {
        throw new ModelHttpError(
          502,
          "missing assistant content and tool_use blocks",
          text.slice(0, 200),
        );
      }

      return { content: outText, toolCalls, usage: extractAnthropicUsage(json) };
    },
  };
}
