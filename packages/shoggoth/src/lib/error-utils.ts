// -----------------------------------------------------------------------------
// error-utils — utilities for formatting error messages
// -----------------------------------------------------------------------------

/**
 * Formats a regex compilation error with position, pattern, and helpful tips
 * Returns structured error data for API responses
 */
export interface RegexErrorData {
  error: string;
  errorType?: string;
  position?: number;
  problematicPattern?: string;
  context?: string;
  tip?: string;
  suggestions?: string[];
}

export function formatRegexError(error: unknown, pattern: string, flags: string): RegexErrorData {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Extract position from error message (e.g., "Invalid regular expression: /pattern/: Unterminated group at position 5")
  // or from pattern analysis based on error type
  let position: number | undefined;

  // First try to extract position from error message
  const positionMatch = errorMessage.match(/at position (\d+)/i);
  if (positionMatch) {
    position = parseInt(positionMatch[1], 10);
  } else {
    // If position is not in error message, try to estimate it based on error type
    // This is a fallback since JavaScript regex errors don't always include position

    // For unterminated character class, the position is at the end of the pattern
    if (errorMessage.toLowerCase().includes("unterminated character class")) {
      position = pattern.length;
    }
    // For unterminated group, the position is at the end of the pattern
    else if (errorMessage.toLowerCase().includes("unterminated group")) {
      position = pattern.length;
    }
    // For numbers out of order in {} quantifier, find the quantifier position
    else if (errorMessage.toLowerCase().includes("numbers out of order")) {
      const quantifierMatch = pattern.match(/\{(\d+),\s*(\d+)\}/);
      if (quantifierMatch) {
        position = pattern.indexOf(quantifierMatch[0]);
      }
    }
    // For invalid escape sequences, find the escape sequence position
    else if (
      errorMessage.toLowerCase().includes("invalid escape") ||
      errorMessage.toLowerCase().includes("escape")
    ) {
      const escapeMatch = pattern.match(/\\[^\s]/);
      if (escapeMatch) {
        position = pattern.indexOf(escapeMatch[0]);
      }
    }
  }

  // Create visual marker for the error position
  let marker = "";
  let context = "";
  if (position !== undefined && position >= 0 && position <= pattern.length) {
    marker = " ".repeat(position) + "^";
    context = `Pattern: /${pattern}/${flags ? ` (${flags})` : ""}\n${marker}`;
  } else {
    context = `Pattern: /${pattern}/${flags ? ` (${flags})` : ""}`;
  }

  // Generate helpful tips based on error type
  let tip = "";
  if (errorMessage.toLowerCase().includes("unterminated")) {
    tip = "Check for unclosed brackets, parentheses, or braces in your pattern.";
  } else if (errorMessage.toLowerCase().includes("invalid escape")) {
    tip =
      "Escape sequences like \\k are not valid in JavaScript regex. Use valid escape sequences like \\d, \\w, \\s, etc.";
  } else if (errorMessage.toLowerCase().includes("quantifier")) {
    tip = "Quantifiers like {n,m} must be properly formatted with numbers and commas.";
  } else if (errorMessage.toLowerCase().includes("bracket")) {
    tip = "Check for unclosed or unbalanced square brackets in your pattern.";
  } else if (errorMessage.toLowerCase().includes("group")) {
    tip = "Check for unclosed or unbalanced parentheses in your pattern.";
  } else {
    tip = "Review your regex pattern for syntax errors.";
  }

  // Generate suggestions
  const suggestions: string[] = [];
  if (errorMessage.toLowerCase().includes("unterminated")) {
    suggestions.push("Add the closing bracket, parenthesis, or brace");
    suggestions.push("Check for nested structures");
    suggestions.push("Verify balanced pairs of delimiters");
  } else if (errorMessage.toLowerCase().includes("invalid escape")) {
    suggestions.push("Use \\d for digits, \\w for word characters, \\s for whitespace");
    suggestions.push("Escape literal backslashes with \\\\");
  } else if (errorMessage.toLowerCase().includes("quantifier")) {
    suggestions.push("Use {n} for exact count, {n,} for at least n, {n,m} for range");
    suggestions.push("Ensure quantifiers follow a valid token");
  }

  // Return formatted error message
  const positionText = position !== undefined ? ` at position ${position}` : "";
  const errorString = `Invalid regular expression${positionText}: ${context}\nDetail: ${errorMessage}\nTip: ${tip}`;

  return {
    error: errorString,
    errorType: "SyntaxError",
    position,
    problematicPattern: pattern,
    context,
    tip,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}
