/**
 * Shared tool name normalization for API compatibility.
 *
 * Some providers (notably Meta via OpenRouter) reject tool names containing dots.
 * This utility provides a consistent normalization that replaces dots with hyphens
 * and enforces the `^[a-zA-Z0-9_-]{1,64}$` pattern used by Anthropic and other APIs.
 */

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOL_NAME_MAX_LENGTH = 64;

/**
 * Normalize a tool name for API compatibility.
 *
 * - Replaces dots (`.`) with hyphens (`-`)
 * - Replaces any other non-alphanumeric/underscore/hyphen characters with underscores
 * - Truncates to 64 characters
 * - Falls back to `"tool"` if the result would be empty
 */
export function sanitizeToolName(name: string): string {
  let s = name.replace(/\./g, "-").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (s.length === 0) s = "tool";
  if (s.length > TOOL_NAME_MAX_LENGTH) s = s.slice(0, TOOL_NAME_MAX_LENGTH);
  return s;
}

/**
 * Check whether a tool name is already API-compatible (no sanitization needed).
 */
export function isToolNameValid(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}
