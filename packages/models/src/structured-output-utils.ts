import type { ChatToolCall } from "./types";

/** Synthetic tool name used for structured output workaround. */
export const STRUCTURED_OUTPUT_TOOL_NAME = "__structured_output__";

/** Shared synthetic tool description used by all provider adapters. */
export const SYNTHETIC_TOOL_DESCRIPTION =
  "Use this tool to provide your final structured response. " +
  "Call it with your answer conforming to the schema.";

/**
 * Build a provider-specific synthetic tool definition used for structured
 * output. Each adapter passes a `formatTool` callback that wraps the common
 * name, description, and schema into its own wire format.
 *
 * @typeParam T – The provider-specific tool definition type.
 */
export function buildSyntheticTool<T>(
  responseSchema: { readonly schema: Record<string, unknown> },
  formatTool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
  ) => T,
): T {
  return formatTool(
    STRUCTURED_OUTPUT_TOOL_NAME,
    SYNTHETIC_TOOL_DESCRIPTION,
    responseSchema.schema,
  );
}

/** Check whether a tool call targets the synthetic structured-output tool. */
export function isSyntheticToolCall(toolCall: ChatToolCall): boolean {
  return toolCall.name === STRUCTURED_OUTPUT_TOOL_NAME;
}
