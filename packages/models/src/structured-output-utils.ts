import type { ChatToolCall } from "./types";

/** Synthetic tool name used for structured output workaround. */
export const STRUCTURED_OUTPUT_TOOL_NAME = "__structured_output__";

/** Check whether a tool call targets the synthetic structured-output tool. */
export function isSyntheticToolCall(toolCall: ChatToolCall): boolean {
  return toolCall.name === STRUCTURED_OUTPUT_TOOL_NAME;
}
