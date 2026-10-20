import type { ChatToolCall, ResponseSchema } from "./types";
import { validateResponseSchema, StructuredOutputValidationError } from "./response-validation";

/** Synthetic tool name used for structured output workaround. */
export const STRUCTURED_OUTPUT_TOOL_NAME = "__structured_output__";

/**
 * Shared synthetic tool description used by all provider adapters.
 *
 * The wording is part of the contract: models under-use the tool (reply with
 * prose, or call it alongside real tools where the call would be discarded),
 * so it states explicitly that the arguments must be a single JSON object
 * matching the advertised schema, that the tool must be called alone as the
 * final action, and that plain text is never captured as structured output.
 */
export const SYNTHETIC_TOOL_DESCRIPTION =
  "Provide your final structured response by calling this tool with a single " +
  "JSON-object argument that conforms exactly to the schema defined in this " +
  "tool's parameters. This tool is the ONLY capture path for structured " +
  "output — plain-text replies are ignored. Call it alone (not in the same " +
  "response as other tool calls) as the very last thing you do, after any " +
  "real tool calls you need to make.";

/**
 * Build a provider-specific synthetic tool definition used for structured
 * output. Each adapter passes a `formatTool` callback that wraps the common
 * name, description, and schema into its own wire format.
 *
 * @typeParam T – The provider-specific tool definition type.
 */
export function buildSyntheticTool<T>(
  responseSchema: { readonly schema: Record<string, unknown> },
  formatTool: (name: string, description: string, schema: Record<string, unknown>) => T,
): T {
  return formatTool(STRUCTURED_OUTPUT_TOOL_NAME, SYNTHETIC_TOOL_DESCRIPTION, responseSchema.schema);
}

/** Check whether a tool call targets the synthetic structured-output tool. */
export function isSyntheticToolCall(toolCall: ChatToolCall): boolean {
  return toolCall.name === STRUCTURED_OUTPUT_TOOL_NAME;
}

/**
 * Parse and validate a synthetic `__structured_output__` tool call's
 * arguments against the response schema.
 *
 * Returns the normalized (re-serialized) JSON string on success. Throws
 * {@link StructuredOutputValidationError} — carrying the raw arguments and the
 * schema — when the arguments are not valid JSON or do not conform, so
 * callers (e.g. the daemon tool loop) can hand the model a concrete schema
 * error and count the attempt against the retry budget instead of silently
 * discarding a non-conformant call.
 *
 * @param mode - When `"strict"`, schema validation is skipped (the provider
 *   enforces the schema server-side); JSON parsing is always enforced.
 * @param finishReason - Provider-reported finish reason for the response that
 *   carried this tool call (e.g. `length` = truncated). Attached to any
 *   validation error so callers can surface truncation explicitly.
 */
export function validateSyntheticToolCall(
  toolCall: ChatToolCall,
  responseSchema: ResponseSchema,
  mode: string,
  finishReason?: string,
): string {
  let structuredContent: string;
  try {
    structuredContent = JSON.stringify(JSON.parse(toolCall.arguments));
  } catch (parseErr) {
    throw new StructuredOutputValidationError(
      `Response is not valid JSON: ${(parseErr as Error).message}`,
      toolCall.arguments,
      responseSchema.schema,
      finishReason,
    );
  }
  if (mode !== "strict") {
    const result = validateResponseSchema(structuredContent, responseSchema.schema);
    if (!result.valid) {
      throw new StructuredOutputValidationError(
        result.error,
        result.rawContent,
        responseSchema.schema,
        finishReason,
      );
    }
  }
  return structuredContent;
}
