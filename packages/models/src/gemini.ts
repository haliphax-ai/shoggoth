import { ModelHttpError } from "./errors";
import { geminiImageBlockCodec } from "./image-codec";
import { getResilienceGate, parseRateLimitHeaders } from "./resilience";
import {
  normalizeThinkingBlocks,
  stripXmlThinkingTags,
  ThinkingStreamNormalizer,
} from "./thinking-normalize";
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

/** Extract usage metadata from a Gemini generateContent response. */
function extractGeminiUsage(json: unknown): ModelUsage | undefined {
  const u = (
    json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }
  ).usageMetadata;
  if (!u || typeof u.promptTokenCount !== "number" || typeof u.candidatesTokenCount !== "number")
    return undefined;
  return { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount };
}

export interface GeminiProviderOptions {
  readonly id: string;
  /** API origin, e.g. "https://generativelanguage.googleapis.com". */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** API version path segment. Default "v1beta". */
  readonly apiVersion?: string;
  readonly fetchImpl?: FetchLike;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_API_VERSION = "v1beta";

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

/**
 * Collapse `ChatMessage[]` into Gemini `systemInstruction` + `contents`.
 *
 * - `role: "system"` → concatenated into `systemInstruction.parts[].text`
 * - `role: "user"` → `{ role: "user", parts: [{ text }] }`
 * - `role: "assistant"` → `{ role: "model", parts: [...] }` (text + functionCall)
 * - Consecutive `role: "tool"` → batched into one `{ role: "tool", parts: [{ functionResponse }...] }`
 */
export function mapChatMessagesToGeminiPayload(messages: readonly ChatMessage[]): {
  systemInstruction?: unknown;
  contents: unknown[];
} {
  const systemParts: string[] = [];
  const contents: unknown[] = [];
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

    if (m.role === "user") {
      if (Array.isArray(m.content)) {
        const parts: unknown[] = [];
        for (const p of m.content as ChatContentPart[]) {
          if (p.type === "text") {
            parts.push({ text: p.text });
          } else if (p.type === "thinking") {
            // Skip thinking blocks in Gemini serialization
          } else {
            // ImageBlock — use Gemini codec
            parts.push(geminiImageBlockCodec.encode(p));
          }
        }
        contents.push({ role: "user", parts });
      } else {
        contents.push({
          role: "user",
          parts: [{ text: m.content != null ? String(m.content) : "" }],
        });
      }
      i += 1;
      continue;
    }

    if (m.role === "assistant") {
      const parts: unknown[] = [];
      const hasText = m.content != null && String(m.content).length > 0;
      if (hasText) {
        parts.push({ text: String(m.content) });
      }
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          let args: unknown;
          try {
            args = tc.arguments.trim() ? JSON.parse(tc.arguments) : {};
          } catch {
            throw new ModelHttpError(
              502,
              "invalid tool call arguments JSON for Gemini mapping",
              tc.arguments.slice(0, 200),
            );
          }
          parts.push({ functionCall: { name: tc.name, args } });
        }
      }
      if (parts.length === 0) {
        parts.push({ text: "" });
      }
      contents.push({ role: "model", parts });
      i += 1;
      continue;
    }

    if (m.role === "tool") {
      const toolParts: unknown[] = [];
      while (i < messages.length && messages[i]!.role === "tool") {
        const tm = messages[i]!;
        const name = tm.name ?? tm.toolCallId ?? "";
        const raw = tm.content != null ? String(tm.content) : "";
        let response: unknown;
        try {
          const parsed = raw.trim() ? JSON.parse(raw) : { result: raw };
          response =
            parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed
              : { result: parsed };
        } catch {
          response = { result: raw };
        }
        toolParts.push({ functionResponse: { name, response } });
        i += 1;
      }
      contents.push({ role: "tool", parts: toolParts });
      continue;
    }

    // Unknown role — skip.
    i += 1;
  }

  const systemInstruction =
    systemParts.length > 0 ? { parts: systemParts.map((t) => ({ text: t })) } : undefined;

  return { systemInstruction, contents };
}

// ---------------------------------------------------------------------------
// Schema sanitization for Gemini
// ---------------------------------------------------------------------------

/**
 * Recursively strip/transform JSON Schema properties that Gemini does not
 * support: `additionalProperties`, `const`, and non-string `enum` values.
 */
export function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const s = { ...(schema as Record<string, unknown>) };

  delete s.additionalProperties;

  if ("const" in s) {
    s.enum = [String(s.const)];
    delete s.const;
  }

  if (Array.isArray(s.enum)) {
    s.enum = s.enum.map((v: unknown) => String(v));
  }

  if (s.properties && typeof s.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      props[k] = sanitizeSchemaForGemini(v);
    }
    s.properties = props;
  }

  if (s.items) s.items = sanitizeSchemaForGemini(s.items);
  if (Array.isArray(s.oneOf)) s.oneOf = s.oneOf.map(sanitizeSchemaForGemini);
  if (Array.isArray(s.anyOf)) s.anyOf = s.anyOf.map(sanitizeSchemaForGemini);
  if (Array.isArray(s.allOf)) s.allOf = s.allOf.map(sanitizeSchemaForGemini);

  return s;
}

// ---------------------------------------------------------------------------
// Tool definition mapping
// ---------------------------------------------------------------------------

function mapOpenAIToolsToGemini(
  tools: readonly OpenAIToolFunctionDefinition[],
): unknown[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        ...(t.function.description !== undefined ? { description: t.function.description } : {}),
        parameters: sanitizeSchemaForGemini(t.function.parameters),
      })),
    },
  ];
}

// ---------------------------------------------------------------------------
// Generation config mapping
// ---------------------------------------------------------------------------

function buildGenerationConfig(
  input: Pick<ModelInvocationParams, "maxOutputTokens" | "temperature">,
): Record<string, unknown> | undefined {
  const cfg: Record<string, unknown> = {};
  if (input.maxOutputTokens !== undefined) cfg.maxOutputTokens = input.maxOutputTokens;
  if (input.temperature !== undefined) cfg.temperature = input.temperature;
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

function applyGeminiRequestExtensions(
  body: Record<string, unknown>,
  input: Pick<ModelInvocationParams, "requestExtras">,
): void {
  const x = input.requestExtras;
  if (x && typeof x === "object") {
    Object.assign(body, x);
  }
}

// ---------------------------------------------------------------------------
// Response parsing (non-streaming)
// ---------------------------------------------------------------------------

function parseGeminiErrorBody(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; status?: string } };
    const msg = j.error?.message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  } catch {
    // ignore
  }
  return text.slice(0, 500);
}

function parseGeminiResponse(
  json: unknown,
  thinkingFormat?: "native" | "xml-tags" | "none",
): {
  content: string | ChatContentPart[] | null;
  toolCalls: ChatToolCall[];
} {
  if (!json || typeof json !== "object") {
    throw new ModelHttpError(502, "invalid Gemini response shape", String(json).slice(0, 200));
  }

  const resp = json as Record<string, unknown>;
  const candidates = resp.candidates as unknown[] | undefined;

  if (!candidates || candidates.length === 0) {
    throw new ModelHttpError(
      502,
      "Gemini response missing candidates",
      JSON.stringify(resp).slice(0, 500),
    );
  }

  const candidate = candidates[0] as Record<string, unknown>;
  const finishReason = candidate.finishReason as string | undefined;

  if (finishReason === "SAFETY") {
    throw new ModelHttpError(
      400,
      "Gemini safety filter triggered",
      JSON.stringify(candidate.safetyRatings ?? {}).slice(0, 500),
    );
  }

  const contentObj = candidate.content as { parts?: unknown[] } | undefined;
  const parts = contentObj?.parts;

  if (!parts || !Array.isArray(parts)) {
    // Some finish reasons (e.g. RECITATION) may have no content.
    return { content: null, toolCalls: [] };
  }

  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  let callIndex = 0;

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;

    if (typeof p.text === "string") {
      textParts.push(thinkingFormat === "xml-tags" ? stripXmlThinkingTags(p.text) : p.text);
    }

    if (p.functionCall && typeof p.functionCall === "object") {
      const fc = p.functionCall as Record<string, unknown>;
      const name = typeof fc.name === "string" ? fc.name : "";
      const id = typeof fc.id === "string" && fc.id.length > 0 ? fc.id : `gemini-call-${callIndex}`;
      let argsStr: string;
      try {
        argsStr = JSON.stringify(fc.args ?? {});
      } catch {
        throw new ModelHttpError(502, "functionCall args not JSON-serializable", "");
      }
      const strippedArgs = thinkingFormat === "xml-tags" ? stripXmlThinkingTags(argsStr) : argsStr;
      toolCalls.push({ id, name, arguments: strippedArgs });
      callIndex += 1;
    }
  }

  const joined = textParts.join("");
  let content: string | ChatContentPart[] | null = joined.length > 0 ? joined : null;

  // Normalize thinking blocks if thinkingFormat is specified and content is not null
  if (content !== null && thinkingFormat) {
    content = normalizeThinkingBlocks(content as string, thinkingFormat);
  }

  return { content, toolCalls };
}

// ---------------------------------------------------------------------------
// Streaming consumer
// ---------------------------------------------------------------------------

export interface ConsumeGeminiStreamOptions {
  readonly accumulateTools: boolean;
  readonly thinkingFormat?: "native" | "xml-tags" | "none";
  readonly onTextDelta?: ModelStreamTextDeltaCallback;
}

/**
 * Consume SSE from Gemini `streamGenerateContent?alt=sse`.
 *
 * Each `data:` line is a full `GenerateContentResponse` JSON (not deltas).
 * There is no `[DONE]` sentinel — the stream simply ends.
 */
export async function consumeGeminiStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeGeminiStreamOptions,
): Promise<{
  content: string | ChatContentPart[] | null;
  toolCalls: ChatToolCall[];
  usage?: ModelUsage;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = "";

  let accumulatedText = "";
  const toolCalls: ChatToolCall[] = [];
  let callIndex = 0;
  let forbiddenToolUse = false;
  let lastUsage: ModelUsage | undefined;
  const thinkNorm =
    options.thinkingFormat === "xml-tags" ? new ThinkingStreamNormalizer() : undefined;

  const handleDataPayload = (raw: string) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ModelHttpError(502, "malformed Gemini SSE data JSON", raw.slice(0, 200));
    }
    if (!json || typeof json !== "object") return;

    const resp = json as Record<string, unknown>;

    // Capture usageMetadata from each chunk; the last one has final totals.
    const extracted = extractGeminiUsage(resp);
    if (extracted) lastUsage = extracted;

    const candidates = resp.candidates as unknown[] | undefined;
    if (!candidates || candidates.length === 0) return;

    const candidate = candidates[0] as Record<string, unknown>;
    const finishReason = candidate.finishReason as string | undefined;

    if (finishReason === "SAFETY") {
      throw new ModelHttpError(
        400,
        "Gemini safety filter triggered",
        JSON.stringify(candidate.safetyRatings ?? {}).slice(0, 500),
      );
    }

    const contentObj = candidate.content as { parts?: unknown[] } | undefined;
    const parts = contentObj?.parts;
    if (!parts || !Array.isArray(parts)) return;

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;

      if (typeof p.text === "string" && p.text.length > 0) {
        if (thinkNorm) {
          const result = thinkNorm.processChunk(p.text);
          if (result.text) {
            accumulatedText += result.text;
            options.onTextDelta?.(result.text, accumulatedText);
          }
        } else {
          accumulatedText += p.text;
          options.onTextDelta?.(p.text, accumulatedText);
        }
      }

      if (p.functionCall && typeof p.functionCall === "object") {
        if (!options.accumulateTools) {
          forbiddenToolUse = true;
        } else {
          const fc = p.functionCall as Record<string, unknown>;
          const name = typeof fc.name === "string" ? fc.name : "";
          const id =
            typeof fc.id === "string" && fc.id.length > 0 ? fc.id : `gemini-call-${callIndex}`;
          let argsStr: string;
          try {
            argsStr = JSON.stringify(fc.args ?? {});
          } catch {
            throw new ModelHttpError(502, "functionCall args not JSON-serializable in stream", "");
          }
          const strippedArgs =
            options.thinkingFormat === "xml-tags" ? stripXmlThinkingTags(argsStr) : argsStr;
          toolCalls.push({ id, name, arguments: strippedArgs });
          callIndex += 1;
        }
      }
    }
  };

  const flushLine = (line: string): void => {
    const trimmed = line.replace(/\r$/, "");
    // SSE comment or empty line — skip.
    if (trimmed === "" || trimmed.startsWith(":")) return;
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice(5).trimStart();
      if (payload.length > 0) handleDataPayload(payload);
    }
    // event: lines and others — ignore.
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

  if (forbiddenToolUse) {
    throw new ModelHttpError(502, "unexpected functionCall in non-tool Gemini stream", "");
  }

  // Flush any remaining buffered thinking content
  if (thinkNorm) {
    const flushed = thinkNorm.flush();
    if (flushed.text) {
      accumulatedText += flushed.text;
    }
  }

  let content: string | ChatContentPart[] | null =
    accumulatedText.length > 0 ? accumulatedText : null;

  // Normalize thinking blocks if thinkingFormat is specified and content is not null
  if (content !== null && options.thinkingFormat) {
    content = normalizeThinkingBlocks(content as string, options.thinkingFormat);
  }

  return { content, toolCalls, usage: lastUsage };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

function headersToRecord(h: Headers): Record<string, string | undefined> {
  const rec: Record<string, string | undefined> = {};
  h.forEach((v, k) => {
    rec[k.toLowerCase()] = v;
  });
  return rec;
}

export function createGeminiProvider(options: GeminiProviderOptions): ModelProvider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const baseUrl = trimSlash(options.baseUrl ?? DEFAULT_BASE_URL);
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const id = options.id;

  async function resilientFetch(targetUrl: string, init: RequestInit): Promise<Response> {
    try {
      const gate = getResilienceGate();
      return await gate.executeWithResilience(id, async () => {
        const res = await fetchImpl(targetUrl, init);
        try {
          const parsed = parseRateLimitHeaders(id, headersToRecord(res.headers), "gemini");
          gate.getOrCreateManager(id).updateCapacity(parsed);
        } catch {
          /* ignore header parse errors */
        }
        if (!res.ok) {
          const errText = await res.text();
          throw new ModelHttpError(
            res.status,
            res.statusText || `HTTP ${res.status}`,
            parseGeminiErrorBody(errText),
          );
        }
        return res;
      });
    } catch (err: unknown) {
      if (err instanceof ModelHttpError) throw err;
      return fetchImpl(targetUrl, init);
    }
  }

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (options.apiKey) {
      headers["x-goog-api-key"] = options.apiKey;
    }
    return headers;
  }

  function endpointUrl(model: string, stream: boolean): string {
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${baseUrl}/${apiVersion}/models/${model}:${action}`;
  }

  return {
    id,

    async complete(input: ModelCompleteInput) {
      const headers = buildHeaders();
      const { systemInstruction, contents } = mapChatMessagesToGeminiPayload(input.messages);

      const body: Record<string, unknown> = { contents };
      if (systemInstruction !== undefined) body.systemInstruction = systemInstruction;
      const genConfig = buildGenerationConfig(input);
      if (genConfig) body.generationConfig = genConfig;
      applyGeminiRequestExtensions(body, input);

      const url = endpointUrl(input.model, input.stream === true);
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
            parseGeminiErrorBody(errText),
          );
        }
        if (!res.body) {
          throw new ModelHttpError(502, "missing response body for Gemini stream", undefined);
        }
        const { content, toolCalls, usage } = await consumeGeminiStream(res.body, {
          accumulateTools: false,
          thinkingFormat: input.thinkingFormat,
          onTextDelta: input.onTextDelta,
        });
        if (toolCalls.length > 0) {
          throw new ModelHttpError(502, "unexpected functionCall in non-tool Gemini stream", "");
        }
        if (content === null) {
          throw new ModelHttpError(502, "missing streamed assistant content", "");
        }
        return { content: typeof content === "string" ? content : JSON.stringify(content), usage };
      }

      const rawText = await res.text();
      if (!res.ok) {
        throw new ModelHttpError(
          res.status,
          res.statusText || `HTTP ${res.status}`,
          parseGeminiErrorBody(rawText),
        );
      }

      const text = input.thinkingFormat === "xml-tags" ? stripXmlThinkingTags(rawText) : rawText;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelHttpError(
          502,
          "invalid JSON from Gemini generateContent endpoint",
          text.slice(0, 200),
        );
      }

      const { content, toolCalls } = parseGeminiResponse(json, input.thinkingFormat);
      if (toolCalls.length > 0) {
        throw new ModelHttpError(
          502,
          "unexpected functionCall in complete() response; use completeWithTools",
          text.slice(0, 200),
        );
      }
      if (content === null) {
        throw new ModelHttpError(
          502,
          "missing assistant text in Gemini response",
          text.slice(0, 200),
        );
      }
      return {
        content: typeof content === "string" ? content : JSON.stringify(content),
        usage: extractGeminiUsage(json),
      };
    },

    async completeWithTools(input: ModelToolCompleteInput): Promise<ModelToolCompleteOutput> {
      const headers = buildHeaders();
      const { systemInstruction, contents } = mapChatMessagesToGeminiPayload(input.messages);

      if (!input.model) {
        throw new Error("Gemini completeWithTools requires input.model");
      }

      const geminiTools = mapOpenAIToolsToGemini(input.tools);

      const body: Record<string, unknown> = { contents };
      if (systemInstruction !== undefined) body.systemInstruction = systemInstruction;
      if (geminiTools) body.tools = geminiTools;
      const genConfig = buildGenerationConfig(input);
      if (genConfig) body.generationConfig = genConfig;
      applyGeminiRequestExtensions(body, input);

      const url = endpointUrl(input.model, input.stream === true);
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
            parseGeminiErrorBody(errText),
          );
        }
        if (!res.body) {
          throw new ModelHttpError(502, "missing response body for Gemini stream", undefined);
        }
        const { content, toolCalls, usage } = await consumeGeminiStream(res.body, {
          accumulateTools: true,
          thinkingFormat: input.thinkingFormat,
          onTextDelta: input.onTextDelta,
        });
        if (toolCalls.length === 0 && (content === null || content === "")) {
          throw new ModelHttpError(502, "missing assistant content and functionCall parts", "");
        }
        return {
          content: typeof content === "string" ? content : JSON.stringify(content),
          toolCalls,
          usage,
        };
      }

      const rawText = await res.text();
      if (!res.ok) {
        throw new ModelHttpError(
          res.status,
          res.statusText || `HTTP ${res.status}`,
          parseGeminiErrorBody(rawText),
        );
      }

      const text = input.thinkingFormat === "xml-tags" ? stripXmlThinkingTags(rawText) : rawText;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelHttpError(
          502,
          "invalid JSON from Gemini generateContent endpoint",
          text.slice(0, 200),
        );
      }

      const { content, toolCalls } = parseGeminiResponse(json, input.thinkingFormat);
      if (toolCalls.length === 0 && (content === null || content === "")) {
        throw new ModelHttpError(
          502,
          "missing assistant content and functionCall parts",
          text.slice(0, 200),
        );
      }
      return {
        content: typeof content === "string" ? content : JSON.stringify(content),
        toolCalls,
        usage: extractGeminiUsage(json),
      };
    },
  };
}
