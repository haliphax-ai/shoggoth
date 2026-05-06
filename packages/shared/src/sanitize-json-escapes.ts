/**
 * Sanitize invalid JSON escape sequences in a raw JSON string.
 *
 * LLMs generating tool call arguments often produce regex patterns with
 * invalid JSON escapes like `\{`, `\(`, `\[`, `\.`, etc. Lenient parsers
 * silently drop the backslash; strict parsers throw. Either way the agent's
 * intent is lost.
 *
 * This function replaces any `\` NOT followed by a valid JSON escape character
 * with `\\`, preserving the original intent.
 *
 * Valid JSON escapes after `\`:
 *   `"`, `\`, `/`, `b`, `f`, `n`, `r`, `t`, `uXXXX` (4 hex digits)
 */
export function sanitizeJsonEscapes(raw: string): string {
  // Fast path: no backslashes means nothing to fix
  if (!raw.includes("\\")) return raw;

  const len = raw.length;
  let result = "";
  let i = 0;

  while (i < len) {
    const ch = raw[i];
    if (ch !== "\\") {
      result += ch;
      i++;
      continue;
    }

    // We have a backslash at position i
    const next = i + 1 < len ? raw[i + 1] : "";

    // Valid single-character escapes
    if (
      next === '"' ||
      next === "\\" ||
      next === "/" ||
      next === "b" ||
      next === "f" ||
      next === "n" ||
      next === "r" ||
      next === "t"
    ) {
      result += ch + next;
      i += 2;
      continue;
    }

    // Valid unicode escape: \uXXXX (exactly 4 hex digits)
    if (next === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
        // Valid \uXXXX escape
        result += raw.slice(i, i + 6);
        i += 6;
        continue;
      }
    }

    // Invalid escape — double the backslash to preserve it
    result += "\\\\";
    i++;
  }

  return result;
}
