// -----------------------------------------------------------------------------
// builtin-read — read file content with optional line formatting
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuiltinReadArgs {
  path: string;
  lines?: boolean;
  lineNumbers?: boolean;
}

export interface BuiltinToolContext {
  workspacePath: string;
}

export async function builtinRead(
  args: BuiltinReadArgs,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const path = args.path ?? "";
  const lines = args.lines === true;
  const lineNumbers = args.lineNumbers === true;

  const fullPath = join(ctx.workspacePath, path);

  try {
    const content = readFileSync(fullPath, "utf-8");

    // Apply line processing if requested
    let resultContent: string | string[];
    if (lines || lineNumbers) {
      // Split by newlines (handle \r\n, \n, and \r in that order to avoid splitting \r\n into \r and \n)
      let rawLines = content.split(/\r\n|\n|\r/);

      // If file is empty, return empty array
      if (content === "") {
        rawLines = [];
      }
      // If file consists only of newlines, keep all lines including trailing empty string
      // Otherwise, if file ends with a newline, remove the trailing empty string
      else if (
        rawLines.length > 0 &&
        rawLines[rawLines.length - 1] === "" &&
        content !== "\n\n\n"
      ) {
        // Check if file is only newlines
        const hasNonNewlineContent = /[^\n\r]/.test(content);
        if (hasNonNewlineContent) {
          rawLines = rawLines.slice(0, -1);
        }
      }

      // Apply line numbers if requested
      if (lineNumbers) {
        resultContent = rawLines.map((line, index) => `${index + 1}: ${line}`);
      } else {
        resultContent = rawLines;
      }

      // Handle truncation for large files (>1000 lines)
      if (lines && rawLines.length > 1000) {
        const truncatedContent = rawLines.slice(0, 1000);
        if (lineNumbers) {
          resultContent = truncatedContent.map((line, index) => `${index + 1}: ${line}`);
        } else {
          resultContent = truncatedContent;
        }
        resultContent.push(
          `[... truncated — file has ${rawLines.length} lines, showing first 1000 ...]`,
        );
      }
    } else {
      // Default behavior: return raw content as string
      resultContent = content;
    }

    return {
      resultJson: JSON.stringify({ path, content: resultContent }),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Failed to read file: ${errorMessage}`,
        path,
      }),
    };
  }
}
