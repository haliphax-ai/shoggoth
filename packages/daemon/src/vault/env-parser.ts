/**
 * Env file parser for bulk vault import.
 */

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
  throw new Error("not implemented");
}