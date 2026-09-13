import { ModelHttpError } from "./errors";
import { isSyntheticToolCall } from "./structured-output-utils";
import {
  validateResponseSchema,
  StructuredOutputValidationError,
} from "./response-validation";
import { stripXmlThinkingTags } from "./thinking-normalize";
import type { ChatMessage, ChatToolCall, ModelUsage, ResponseSchema } from "./types";

/** Nudge message appended when forcing the model to use the structured output tool. */
export const FOLLOW_UP_NUDGE =
  "Please provide your response using the __structured_output__ tool.";

/**
 * Build the follow-up messages array for a structured-output follow-up call.
 * Appends the assistant's text response and a user nudge to the original messages.
 */
export function buildFollowUpMessages(
  messages: readonly ChatMessage[],
  assistantText: string,
): ChatMessage[] {
  return [
    ...messages,
    { role: "assistant" as const, content: assistantText ?? "" },
    { role: "user" as const, content: FOLLOW_UP_NUDGE },
  ];
}

/**
 * Execute a provider-agnostic follow-up API call and parse the JSON response.
 * Handles the common pattern: POST → text → strip thinking tags → JSON.parse.
 *
 * @param fetchFn - The fetch implementation (e.g. `resilientFetch`).
 * @param url - The API endpoint URL.
 * @param headers - Request headers.
 * @param body - The request body (will be JSON-serialised).
 * @param thinkingFormat - If `"xml-tags"`, thinking tags are stripped before parsing.
 * @param options.formatErrorBody - Optional transform for the error body on non-2xx responses.
 * @param options.jsonErrorMessage - Custom message for JSON parse failures.
 */
export async function executeStructuredOutputApiCall(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  thinkingFormat?: string,
  options?: {
    formatErrorBody?: (rawText: string) => string;
    jsonErrorMessage?: string;
  },
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new ModelHttpError(
      res.status,
      res.statusText || `HTTP ${res.status}`,
      options?.formatErrorBody
        ? options.formatErrorBody(rawText)
        : rawText.slice(0, 500),
    );
  }

  const text =
    thinkingFormat === "xml-tags" ? stripXmlThinkingTags(rawText) : rawText;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ModelHttpError(
      502,
      options?.jsonErrorMessage ?? "invalid JSON from model endpoint",
      text.slice(0, 200),
    );
  }
  return json;
}

/**
 * Find the synthetic structured-output tool call and validate it.
 *
 * Returns the structured content string if found and valid, or `null` if no
 * synthetic call is present.  Throws `StructuredOutputValidationError` when
 * validation fails.
 */
export function findAndValidateForcedToolCall(
  toolCalls: readonly ChatToolCall[],
  responseSchema: ResponseSchema,
  mode: string,
): string | null {
  const forced = toolCalls.find((tc) => isSyntheticToolCall(tc));
  if (!forced) return null;

  const structuredContent = forced.arguments;
  if (mode !== "strict") {
    const result = validateResponseSchema(
      structuredContent,
      responseSchema.schema,
    );
    if (!result.valid) {
      throw new StructuredOutputValidationError(
        result.error,
        result.rawContent,
        responseSchema.schema,
      );
    }
  }
  return structuredContent;
}

/**
 * Options for the structured-output follow-up call.
 */
export interface StructuredOutputFollowUpOptions {
  /** Original messages from the input. */
  readonly messages: readonly ChatMessage[];
  /** The text response from the model. */
  readonly assistantText: string;
  /** Response schema for validation. */
  readonly responseSchema: ResponseSchema;
  /** Structured output mode (`"strict"`, `"best-effort"`, `"none"`). */
  readonly mode: string;
  /**
   * Provider-specific callback: build and execute the follow-up API call.
   * Receives the follow-up messages (original + assistant text + nudge).
   * Should return the parsed response JSON.
   */
  readonly executeFollowUp: (
    followUpMessages: ChatMessage[],
  ) => Promise<unknown>;
  /**
   * Provider-specific callback: extract tool calls from the parsed response JSON.
   */
  readonly extractToolCalls: (responseJson: unknown) => ChatToolCall[];
  /**
   * Provider-specific callback: extract usage from the parsed response JSON.
   */
  readonly extractUsage: (responseJson: unknown) => ModelUsage | undefined;
}

/**
 * Execute a structured-output follow-up call.
 *
 * When the model returns text instead of using the structured output tool,
 * this function orchestrates a second API call with `tool_choice` targeting
 * the structured output tool to force the model to return structured output.
 *
 * Returns the structured content and usage if the follow-up succeeds, or
 * `null` if no synthetic tool call was found in the response.
 */
export async function structuredOutputFollowUp(
  options: StructuredOutputFollowUpOptions,
): Promise<{ content: string; usage: ModelUsage | undefined } | null> {
  const followUpMessages = buildFollowUpMessages(
    options.messages,
    options.assistantText,
  );
  const responseJson = await options.executeFollowUp(followUpMessages);
  const toolCalls = options.extractToolCalls(responseJson);
  const structuredContent = findAndValidateForcedToolCall(
    toolCalls,
    options.responseSchema,
    options.mode,
  );
  if (structuredContent === null) return null;
  return {
    content: structuredContent,
    usage: options.extractUsage(responseJson),
  };
}
