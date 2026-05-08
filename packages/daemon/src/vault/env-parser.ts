/**
 * Env file parser for bulk vault import.
 */

/**
 * Strip surrounding quotes from a value if present.
 * Handles both single and double quotes.
 */
function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a .env-style file into key-value pairs.
 * - Lines starting with # are comments (ignored).
 * - Blank lines are ignored.
 * - Format: KEY=VALUE (first = splits key from value).
 * - Values may be optionally quoted (single or double quotes stripped).
 * - No variable interpolation.
 */
export function parseEnvFile(
  content: string,
): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];

  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    // Skip comment lines (starting with # after trimming)
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    // Split on first '='
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      // Skip lines without '='
      continue;
    }

    // Extract key and value
    const key = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1);

    // Skip if key is empty after trimming
    if (!key) {
      continue;
    }

    // Strip optional surrounding quotes from value
    const value = stripQuotes(rawValue);

    result.push({ key, value });
  }

  return result;
}