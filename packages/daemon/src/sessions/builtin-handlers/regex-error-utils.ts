// -----------------------------------------------------------------------------
// Regex error formatting utility
// -----------------------------------------------------------------------------

/**
 * Format a regex compilation error with position and helpful tips.
 * @param error - The error thrown by RegExp constructor
 * @param pattern - The regex pattern string that failed to compile
 * @returns Structured error information with formatted message, position, and tip
 */
export function formatRegexError(
  error: unknown,
  pattern: string,
): { error: string; position?: number; tip?: string } {
  const message = error instanceof Error ? error.message : String(error);

  // Extract position from error message (e.g., "at position 5")
  const positionMatch = message.match(/at position (\d+)/i);
  const position = positionMatch ? parseInt(positionMatch[1], 10) : undefined;

  // Determine tip based on error type
  let tip: string | undefined;
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("unterminated")) {
    tip = "Check for unclosed brackets, parentheses, or braces.";
  } else if (lowerMessage.includes("invalid escape")) {
    tip = "Use valid escape sequences like \\d, \\w, \\s.";
  } else if (lowerMessage.includes("quantifier")) {
    tip = "Quantifiers like {n,m} must be properly formatted.";
  } else {
    tip = "Review your regex pattern for syntax errors.";
  }

  // Build formatted error with visual marker
  let formattedError = `Regex error: ${message}`;

  if (position !== undefined) {
    // Create a visual marker showing where parsing failed
    // Pattern: /[abc/\n             ^
    const markerLine = " ".repeat(position) + "^";
    formattedError += `\nPattern: ${pattern}\n${markerLine}`;
  }

  return {
    error: formattedError,
    position,
    tip,
  };
}
