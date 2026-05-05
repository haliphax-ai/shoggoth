// -----------------------------------------------------------------------------
// builtin-search — search for patterns in files
// -----------------------------------------------------------------------------

import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { formatRegexError } from "../lib/error-utils";

export interface BuiltinSearchParams {
  path: string;
  pattern: string;
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
}

export interface BuiltinToolContext {
  workspacePath: string;
}

export interface SearchMatch {
  filePath: string;
  lineNumber: number;
  context: string;
  matchedText: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
}

export async function builtinSearch(
  args: BuiltinSearchParams,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  try {
    const path = args.path;
    const pattern = args.pattern;
    const caseSensitive = args.caseSensitive ?? false;
    const contextLines = args.contextLines ?? 2;
    const maxResults = args.maxResults ?? 100;

    if (!pattern) {
      return {
        resultJson: JSON.stringify({
          matches: [],
          totalMatches: 0,
        }),
      };
    }

    // Resolve the full path
    const fullPath = resolve(ctx.workspacePath, path);

    // Check if path exists
    if (!existsSync(fullPath)) {
      return {
        resultJson: JSON.stringify({
          error: `Path not found: ${path}`,
          matches: [],
          totalMatches: 0,
        }),
      };
    }

    // Check if it's a directory or file
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return await searchDirectory(
        fullPath,
        pattern,
        caseSensitive,
        contextLines,
        maxResults,
        ctx.workspacePath,
      );
    } else {
      return await searchFile(
        fullPath,
        pattern,
        caseSensitive,
        contextLines,
        maxResults,
        ctx.workspacePath,
        path,
      );
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Search failed: ${errorMessage}`,
        matches: [],
        totalMatches: 0,
      }),
    };
  }
}

async function searchFile(
  filePath: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
  maxResults: number,
  workspacePath: string,
): Promise<{ resultJson: string }> {
  const matches: SearchMatch[] = [];
  let totalMatches = 0;

  try {
    // Create regex from pattern
    const flags = caseSensitive ? "g" : "gi";
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (error) {
      const errorData = formatRegexError(error, pattern, flags);
      return {
        resultJson: JSON.stringify(errorData),
      };
    }

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // Search through lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineMatches = [...line.matchAll(regex)];

      for (const match of lineMatches) {
        totalMatches++;

        if (matches.length < maxResults) {
          // Calculate context
          const startLine = Math.max(0, i - contextLines);
          const endLine = Math.min(lines.length - 1, i + contextLines);
          const contextLinesArray = lines.slice(startLine, endLine + 1);
          const context = contextLinesArray.join("\n");

          // Get relative path for display
          const relativePath = relative(workspacePath, filePath);

          matches.push({
            filePath: relativePath,
            lineNumber: i + 1,
            context,
            matchedText: match[0],
          });
        }
      }
    }

    return {
      resultJson: JSON.stringify({
        matches,
        totalMatches,
      }),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Failed to search file: ${errorMessage}`,
        matches: [],
        totalMatches: 0,
      }),
    };
  }
}

async function searchDirectory(
  dirPath: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
  maxResults: number,
  workspacePath: string,
): Promise<{ resultJson: string }> {
  const matches: SearchMatch[] = [];
  let totalMatches = 0;

  try {
    // Read directory contents
    const items = readdirSync(dirPath, { withFileTypes: true });

    // Process files in the directory (non-recursive for now)
    for (const item of items) {
      if (matches.length >= maxResults) break;

      if (item.isFile()) {
        const filePath = join(dirPath, item.name);
        const fileResult = await searchFile(
          filePath,
          pattern,
          caseSensitive,
          0, // No context for directory search to save memory
          maxResults - matches.length,
          workspacePath,
        );

        const parsed = JSON.parse(fileResult.resultJson);
        if (parsed.error) {
          continue; // Skip files with errors
        }

        matches.push(...parsed.matches);
        totalMatches += parsed.totalMatches;
      }
    }

    return {
      resultJson: JSON.stringify({
        matches,
        totalMatches,
      }),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Failed to search directory: ${errorMessage}`,
        matches: [],
        totalMatches: 0,
      }),
    };
  }
}
