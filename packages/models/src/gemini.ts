import { ModelHttpError } from "./errors";
import { trimSlash } from "./trim-slash";
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  buildSyntheticTool as buildSyntheticToolRaw,
  isSyntheticToolCall,
} from "./structured-output-utils";
import {
  structuredOutputFollowUp,
  executeStructuredOutputApiCall,
} from "./structured-output-follow-up";
import { geminiImageBlockCodec } from "./image-codec";
import { getResilienceGate, type ModelResilienceGate } from "./resilience";
import {
  createResilientFetcher,
  safeJsonParse,
  assertResponseOk,
  assertResponseBody,
} from "./resilient-fetch";
import { parseApiErrorBody } from "./parse-api-error-body";
import {
  resolveStructuredOutputMode,
  validateResponseSchema,
  StructuredOutputValidationError,
} from "./response-validation";
import {
  normalizeThinkingBlocks,
  stripXmlThinkingTags,
  ThinkingStreamNormalizer,
} from "./thinking-normalize";
import type {
  ChatContentPart,
  ChatMessage,
  ChatToolCall,
  ModelCapabilities,
  ModelCompleteInput,
  ModelInvocationParams,
  ModelProvider,
  ModelStreamTextDeltaCallback,
  ModelToolCompleteInput,
  ModelToolCompleteOutput,
  ModelUsage,
  OpenAIToolFunctionDefinition,
  ResponseSchema,
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
  /** Optional resilience gate instance; falls back to the global singleton when omitted. */
  readonly resilienceGate?: ModelResilienceGate;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_API_VERSION = "v1beta";

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
          const fcPart: Record<string, unknown> = { functionCall: { name: tc.name, args } };
          // Gemini 3.x requires thought_signature on every functionCall part.
          // Use the real signature when available; fall back to the documented
          // bypass dummy for legacy transcript entries that predate capture.
          fcPart.thought_signature = tc.thoughtSignature || "context_engineering_is_the_way_to_go";
          parts.push(fcPart);
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
    s.type = "string";
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

/** Build a Gemini-compatible synthetic __structured_output__ function declaration. */
function buildGeminiSyntheticTool(responseSchema: ResponseSchema): unknown {
  return buildSyntheticToolRaw(responseSchema, (name, description, schema) => ({
    name,
    description,
    parameters: sanitizeSchemaForGemini(schema),
  }));
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
      const thoughtSig = typeof p.thought_signature === "string" ? p.thought_signature : undefined;
      toolCalls.push({
        id,
        name,
        arguments: strippedArgs,
        ...(thoughtSig ? { thoughtSignature: thoughtSig } : {}),
      });
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
    const json = safeJsonParse(raw, "malformed Gemini SSE data JSON");
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
          const thoughtSig =
            typeof p.thought_signature === "string" ? p.thought_signature : undefined;
          toolCalls.push({
            id,
            name,
            arguments: strippedArgs,
            ...(thoughtSig ? { thoughtSignature: thoughtSig } : {}),
          });
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

export function createGeminiProvider(options: GeminiProviderOptions): ModelProvider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const baseUrl = trimSlash(options.baseUrl ?? DEFAULT_BASE_URL);
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const id = options.id;
  const gate = options.resilienceGate ?? getResilienceGate();

  const resilientFetch = createResilientFetcher({
    id,
    gate,
    fetchImpl,
    providerType: "gemini",
    formatErrorBody: parseApiErrorBody,
  });

  const providerCapabilities: ModelCapabilities = {
    thinkingFormat: "xml-tags",
    imageInput: true,
  };

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
    capabilities: providerCapabilities,

    async complete(input: ModelCompleteInput) {
      const headers = buildHeaders();
      const { systemInstruction, contents } = mapChatMessagesToGeminiPayload(input.messages);

      const body: Record<string, unknown> = { contents };
      if (systemInstruction !== undefined) body.systemInstruction = systemInstruction;
      const genConfig = buildGenerationConfig(input) ?? {};
      body.generationConfig = genConfig;
      applyGeminiRequestExtensions(body, input);

      // Structured output: add responseSchema to generationConfig
      const mode = resolveStructuredOutputMode(input.structuredOutputMode, "best-effort");
      if (input.responseSchema && mode !== "none") {
        genConfig.responseMimeType = "application/json";
        genConfig.responseSchema = sanitizeSchemaForGemini(input.responseSchema.schema);
      }

      // Remove empty generationConfig to keep request clean
      if (Object.keys(genConfig).length === 0) delete body.generationConfig;

      const url = endpointUrl(input.model, input.stream === true);
      const res = await resilientFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (input.stream === true) {
        await assertResponseOk(res, parseApiErrorBody);
        const streamBody = assertResponseBody(res, "Gemini stream");
        const { content, toolCalls, usage } = await consumeGeminiStream(streamBody, {
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
        return {
          content:
            typeof content === "string" ? content : content === null ? "" : JSON.stringify(content),
          usage,
        };
      }

      await assertResponseOk(res, parseApiErrorBody);
      const rawText = await res.text();

      const text = input.thinkingFormat === "xml-tags" ? stripXmlThinkingTags(rawText) : rawText;
      const json = safeJsonParse(text, "invalid JSON from Gemini generateContent endpoint");

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
      const finalContent =
        typeof content === "string" ? content : content === null ? "" : JSON.stringify(content);

      // Structured output: post-validate when mode is "best-effort"
      if (input.responseSchema && mode !== "strict" && mode !== "none") {
        const result = validateResponseSchema(finalContent, input.responseSchema.schema);
        if (!result.valid) {
          throw new StructuredOutputValidationError(
            result.error,
            result.rawContent,
            input.responseSchema.schema,
          );
        }
      }

      return {
        content: finalContent,
        usage: extractGeminiUsage(json),
      };
    },

    async completeWithTools(input: ModelToolCompleteInput): Promise<ModelToolCompleteOutput> {
      const headers = buildHeaders();
      const { systemInstruction, contents } = mapChatMessagesToGeminiPayload(input.messages);

      if (!input.model) {
        throw new Error("Gemini completeWithTools requires input.model");
      }

      // Capture narrowed model for use in closures
      const modelId = input.model;

      // Structured output: inject synthetic tool instead of responseMimeType
      // (responseMimeType/responseSchema prevent tool calling)
      const mode = resolveStructuredOutputMode(input.structuredOutputMode, "best-effort");
      const hasSchema = input.responseSchema && mode !== "none";

      const geminiTools = mapOpenAIToolsToGemini(input.tools);

      const body: Record<string, unknown> = { contents };
      if (systemInstruction !== undefined) body.systemInstruction = systemInstruction;

      // Inject synthetic structured-output tool
      if (hasSchema) {
        const syntheticDecl = buildGeminiSyntheticTool(input.responseSchema!);
        const fnDecls = geminiTools
          ? (geminiTools[0] as { functionDeclarations: unknown[] }).functionDeclarations
          : [];
        fnDecls.push(syntheticDecl);
        body.tools = [{ functionDeclarations: fnDecls }];
      } else if (geminiTools) {
        body.tools = geminiTools;
      }

      const genConfig = buildGenerationConfig(input) ?? {};
      body.generationConfig = genConfig;
      applyGeminiRequestExtensions(body, input);

      // Structured output: add toolConfig for auto function calling
      if (hasSchema) {
        genConfig.functionCallingConfig = { mode: "AUTO" };
      }

      // Remove empty generationConfig to keep request clean
      if (Object.keys(genConfig).length === 0) delete body.generationConfig;

      const url = endpointUrl(input.model, input.stream === true);
      const res = await resilientFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (input.stream === true) {
        await assertResponseOk(res, parseApiErrorBody);
        const streamBody = assertResponseBody(res, "Gemini stream");
        const { content, toolCalls, usage } = await consumeGeminiStream(streamBody, {
          accumulateTools: true,
          thinkingFormat: input.thinkingFormat,
          onTextDelta: input.onTextDelta,
        });
        if (toolCalls.length === 0 && (content === null || content === "")) {
          throw new ModelHttpError(502, "missing assistant content and functionCall parts", "");
        }

        if (hasSchema) {
          const realCalls = toolCalls.filter((tc) => !isSyntheticToolCall(tc));
          const syntheticCall = toolCalls.find((tc) => isSyntheticToolCall(tc));

          if (syntheticCall && realCalls.length === 0) {
            // Terminal: model is done, extract structured content
            let structuredContent: string;
            try {
              structuredContent = JSON.stringify(JSON.parse(syntheticCall.arguments));
            } catch (parseErr) {
              throw new StructuredOutputValidationError(
                `Response is not valid JSON: ${(parseErr as Error).message}`,
                syntheticCall.arguments,
                input.responseSchema!.schema,
              );
            }
            if (mode !== "strict") {
              const result = validateResponseSchema(
                structuredContent,
                input.responseSchema!.schema,
              );
              if (!result.valid) {
                throw new StructuredOutputValidationError(
                  result.error,
                  result.rawContent,
                  input.responseSchema!.schema,
                );
              }
            }
            return { content: structuredContent, toolCalls: [], usage };
          }
          if (syntheticCall && realCalls.length > 0) {
            // Mixed: strip synthetic, return only real tool calls
            return {
              content:
                typeof content === "string"
                  ? content
                  : content === null
                    ? null
                    : JSON.stringify(content),
              toolCalls: realCalls,
              usage,
            };
          }
          if (!syntheticCall && toolCalls.length === 0) {
            // Model returned text only — trigger follow-up
            const textContent =
              typeof content === "string"
                ? content
                : content === null
                  ? ""
                  : JSON.stringify(content);
            const followUpResult = await structuredOutputFollowUp({
              messages: input.messages,
              assistantText: textContent,
              responseSchema: input.responseSchema!,
              mode,
              executeFollowUp: async (followUpMessages) => {
                const { systemInstruction: followUpSystem, contents: followUpContents } =
                  mapChatMessagesToGeminiPayload(followUpMessages);

                const followUpGeminiTools = mapOpenAIToolsToGemini(input.tools);
                const syntheticDecl = buildGeminiSyntheticTool(input.responseSchema!);
                let toolsForFollowUp: unknown[];
                if (followUpGeminiTools) {
                  const fnDecls = (followUpGeminiTools[0] as { functionDeclarations: unknown[] })
                    .functionDeclarations;
                  fnDecls.push(syntheticDecl);
                  toolsForFollowUp = [{ functionDeclarations: fnDecls }];
                } else {
                  toolsForFollowUp = [{ functionDeclarations: [syntheticDecl] }];
                }

                const followUpBody: Record<string, unknown> = { contents: followUpContents };
                if (followUpSystem !== undefined) followUpBody.systemInstruction = followUpSystem;
                followUpBody.tools = toolsForFollowUp;
                followUpBody.generationConfig = {
                  ...buildGenerationConfig(input),
                  functionCallingConfig: {
                    mode: "ANY",
                    allowedFunctionNames: [STRUCTURED_OUTPUT_TOOL_NAME],
                  },
                };

                const followUpUrl = endpointUrl(modelId, false);
                return executeStructuredOutputApiCall(
                  resilientFetch,
                  followUpUrl,
                  headers,
                  followUpBody,
                  input.thinkingFormat,
                  { formatErrorBody: parseApiErrorBody },
                );
              },
              extractToolCalls: (responseJson) => {
                const { toolCalls: parsedToolCalls } = parseGeminiResponse(
                  responseJson,
                  input.thinkingFormat,
                );
                return parsedToolCalls;
              },
              extractUsage: extractGeminiUsage,
            });
            if (followUpResult) {
              return {
                content: followUpResult.content,
                toolCalls: [],
                usage: followUpResult.usage,
              };
            }
          }
        }

        return {
          content:
            typeof content === "string"
              ? content
              : content === null
                ? null
                : JSON.stringify(content),
          toolCalls,
          usage,
        };
      }

      await assertResponseOk(res, parseApiErrorBody);
      const rawText = await res.text();

      const text = input.thinkingFormat === "xml-tags" ? stripXmlThinkingTags(rawText) : rawText;
      const json = safeJsonParse(text, "invalid JSON from Gemini generateContent endpoint");

      const { content, toolCalls } = parseGeminiResponse(json, input.thinkingFormat);
      if (toolCalls.length === 0 && (content === null || content === "")) {
        throw new ModelHttpError(
          502,
          "missing assistant content and functionCall parts",
          text.slice(0, 200),
        );
      }
      const finalContent =
        typeof content === "string" ? content : content === null ? null : JSON.stringify(content);

      // Structured output: classify tool calls and handle synthetic tool
      if (hasSchema) {
        const realCalls = toolCalls.filter((tc) => !isSyntheticToolCall(tc));
        const syntheticCall = toolCalls.find((tc) => isSyntheticToolCall(tc));

        if (syntheticCall && realCalls.length === 0) {
          // Terminal: model is done, extract structured content
          let structuredContent: string;
          try {
            structuredContent = JSON.stringify(JSON.parse(syntheticCall.arguments));
          } catch (parseErr) {
            throw new StructuredOutputValidationError(
              `Response is not valid JSON: ${(parseErr as Error).message}`,
              syntheticCall.arguments,
              input.responseSchema!.schema,
            );
          }
          if (mode !== "strict") {
            const result = validateResponseSchema(structuredContent, input.responseSchema!.schema);
            if (!result.valid) {
              throw new StructuredOutputValidationError(
                result.error,
                result.rawContent,
                input.responseSchema!.schema,
              );
            }
          }
          return { content: structuredContent, toolCalls: [], usage: extractGeminiUsage(json) };
        }
        if (syntheticCall && realCalls.length > 0) {
          // Mixed: strip synthetic, return only real tool calls
          return {
            content: finalContent,
            toolCalls: realCalls,
            usage: extractGeminiUsage(json),
          };
        }
        if (!syntheticCall && toolCalls.length === 0) {
          // Model returned text only — trigger follow-up
          const followUpResult = await structuredOutputFollowUp({
            messages: input.messages,
            assistantText: finalContent ?? "",
            responseSchema: input.responseSchema!,
            mode,
            executeFollowUp: async (followUpMessages) => {
              const { systemInstruction: followUpSystem, contents: followUpContents } =
                mapChatMessagesToGeminiPayload(followUpMessages);

              const followUpGeminiTools = mapOpenAIToolsToGemini(input.tools);
              const syntheticDecl = buildGeminiSyntheticTool(input.responseSchema!);
              let toolsForFollowUp: unknown[];
              if (followUpGeminiTools) {
                const fnDecls = (followUpGeminiTools[0] as { functionDeclarations: unknown[] })
                  .functionDeclarations;
                fnDecls.push(syntheticDecl);
                toolsForFollowUp = [{ functionDeclarations: fnDecls }];
              } else {
                toolsForFollowUp = [{ functionDeclarations: [syntheticDecl] }];
              }

              const followUpBody: Record<string, unknown> = { contents: followUpContents };
              if (followUpSystem !== undefined) followUpBody.systemInstruction = followUpSystem;
              followUpBody.tools = toolsForFollowUp;
              followUpBody.generationConfig = {
                ...buildGenerationConfig(input),
                functionCallingConfig: {
                  mode: "ANY",
                  allowedFunctionNames: [STRUCTURED_OUTPUT_TOOL_NAME],
                },
              };

              const followUpUrl = endpointUrl(modelId, false);
              return executeStructuredOutputApiCall(
                resilientFetch,
                followUpUrl,
                headers,
                followUpBody,
                input.thinkingFormat,
                { formatErrorBody: parseApiErrorBody },
              );
            },
            extractToolCalls: (responseJson) => {
              const { toolCalls: parsedToolCalls } = parseGeminiResponse(
                responseJson,
                input.thinkingFormat,
              );
              return parsedToolCalls;
            },
            extractUsage: extractGeminiUsage,
          });
          if (followUpResult) {
            return { content: followUpResult.content, toolCalls: [], usage: followUpResult.usage };
          }
        }
      }

      return {
        content: finalContent,
        toolCalls,
        usage: extractGeminiUsage(json),
      };
    },
  };
}
