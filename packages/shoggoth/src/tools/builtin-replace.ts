// -----------------------------------------------------------------------------
// builtin-replace — replace patterns in files
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatRegexError } from "../lib/error-utils";

export interface BuiltinReplaceParams {
  path: string;
  pattern: string;
  replacement: string;
  caseSensitive?: boolean;
  maxOccurrences?: number;
  dryRun?: boolean;
  deleteLines?: number[];
  deleteRange?: { start: number; end: number };
  replaceRange?: { start: number; end: number; replacement: string | string[] };
}

export interface BuiltinToolContext {
  workspacePath: string;
}

export interface ReplaceResult {
  modified: boolean;
  changesMade: number;
  preview?: string;
  deletedLines?: number;
  replacedLines?: number;
}

export async function builtinReplace(
  args: BuiltinReplaceParams,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  try {
    const path = args.path;
    const pattern = args.pattern;
    const replacement = args.replacement;
    const caseSensitive = args.caseSensitive ?? false;
    const maxOccurrences = args.maxOccurrences ?? Infinity;
    const dryRun = args.dryRun ?? false;
    const deleteLines = args.deleteLines;
    const deleteRange = args.deleteRange;
    const replaceRange = args.replaceRange;

    // Resolve the full path
    const fullPath = resolve(ctx.workspacePath, path);

    // Check if path exists
    if (!existsSync(fullPath)) {
      return {
        resultJson: JSON.stringify({
          error: `Path not found: ${path}`,
          modified: false,
          changesMade: 0,
        }),
      };
    }

    // Check if it's a file (not directory)
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return {
        resultJson: JSON.stringify({
          error: `Cannot replace in directory: ${path}`,
          modified: false,
          changesMade: 0,
        }),
      };
    }

    // Handle line-level operations first
    if (deleteLines || deleteRange) {
      return await handleLineDeletion(fullPath, deleteLines, deleteRange, dryRun);
    }

    if (replaceRange) {
      return await handleRangeReplacement(fullPath, replaceRange, dryRun);
    }

    // Handle regex replacement
    if (!pattern) {
      return {
        resultJson: JSON.stringify({
          error: "Pattern is required",
          modified: false,
          changesMade: 0,
        }),
      };
    }

    return await handleRegexReplacement(
      fullPath,
      pattern,
      replacement,
      caseSensitive,
      maxOccurrences,
      dryRun,
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Replace failed: ${errorMessage}`,
        modified: false,
        changesMade: 0,
      }),
    };
  }
}

async function handleRegexReplacement(
  filePath: string,
  pattern: string,
  replacement: string,
  caseSensitive: boolean,
  maxOccurrences: number,
  dryRun: boolean,
): Promise<{ resultJson: string }> {
  try {
    const content = readFileSync(filePath, "utf-8");

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

    // Find all matches
    const matches = [...content.matchAll(regex)];
    const changesMade = matches.length;

    // Check safety limit
    if (changesMade > 1000) {
      return {
        resultJson: JSON.stringify({
          warning: `Large number of replacements (${changesMade}) detected. Use with caution.`,
          modified: false,
          changesMade,
        }),
      };
    }

    // Apply replacements with limit
    let modifiedContent = content;
    let replacementsMade = 0;
    const preview: Array<{ lineNumber: number; before: string; after: string }> = [];

    // Split into lines for better preview
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineMatches = [...line.matchAll(regex)];

      for (const match of lineMatches) {
        if (replacementsMade >= maxOccurrences) break;

        const before = line;
        const after = line.replace(match[0], replacement);

        if (before !== after) {
          preview.push({
            lineNumber: i + 1,
            before,
            after,
          });

          if (!dryRun) {
            // Replace in the full content
            modifiedContent = modifiedContent.replace(match[0], replacement);
          }

          replacementsMade++;
        }
      }
    }

    // Write file if not dry run
    if (!dryRun) {
      writeFileSync(filePath, modifiedContent, "utf-8");
    }

    const result: ReplaceResult = {
      modified: !dryRun,
      changesMade: replacementsMade,
    };

    if (dryRun && preview.length > 0) {
      result.preview = formatPreview(preview);
    }

    return {
      resultJson: JSON.stringify(result),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Failed to replace: ${errorMessage}`,
        modified: false,
        changesMade: 0,
      }),
    };
  }
}

async function handleLineDeletion(
  filePath: string,
  deleteLines?: number[],
  deleteRange?: { start: number; end: number },
  dryRun?: boolean,
): Promise<{ resultJson: string }> {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    let deleteSet: Set<number>;
    if (deleteLines) {
      deleteSet = new Set(deleteLines.map((ln) => Math.max(1, Math.min(ln, lines.length))));
    } else if (deleteRange) {
      const { start, end } = deleteRange;
      if (start < 1 || end > lines.length || start > end) {
        return {
          resultJson: JSON.stringify({
            error: `Invalid range: start=${start}, end=${end}, totalLines=${lines.length}`,
            modified: false,
            deletedLines: 0,
          }),
        };
      }

      deleteSet = new Set(Array.from({ length: end - start + 1 }, (_, i) => start + i));
    } else {
      return {
        resultJson: JSON.stringify({
          error: "No deletion parameters provided",
          modified: false,
          deletedLines: 0,
        }),
      };
    }

    const newLines = lines.filter((_, i) => !deleteSet.has(i + 1));
    const newContent = newLines.join("\n") + (content.endsWith("\n") ? "\n" : "");

    if (!dryRun) {
      writeFileSync(filePath, newContent, "utf-8");
    }

    return {
      resultJson: JSON.stringify({
        modified: !dryRun,
        deletedLines: deleteSet.size,
      }),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Failed to delete lines: ${errorMessage}`,
        modified: false,
        deletedLines: 0,
      }),
    };
  }
}

async function handleRangeReplacement(
  filePath: string,
  replaceRange: { start: number; end: number; replacement: string | string[] },
  dryRun?: boolean,
): Promise<{ resultJson: string }> {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    const { start, end, replacement } = replaceRange;

    if (start < 1 || end > lines.length || start > end) {
      return {
        resultJson: JSON.stringify({
          error: `Invalid range: start=${start}, end=${end}, totalLines=${lines.length}`,
          modified: false,
          replacedLines: 0,
        }),
      };
    }

    const replacementLines = Array.isArray(replacement) ? replacement : [replacement];

    const beforeLines = lines.slice(0, start - 1);
    const afterLines = lines.slice(end);
    const newLines = [...beforeLines, ...replacementLines, ...afterLines];
    const newContent = newLines.join("\n") + (content.endsWith("\n") ? "\n" : "");

    if (!dryRun) {
      writeFileSync(filePath, newContent, "utf-8");
    }

    return {
      resultJson: JSON.stringify({
        modified: !dryRun,
        replacedLines: end - start + 1,
      }),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Failed to replace range: ${errorMessage}`,
        modified: false,
        replacedLines: 0,
      }),
    };
  }
}

function formatPreview(
  changes: Array<{ lineNumber: number; before: string; after: string }>,
): string {
  const lines = changes
    .map(
      (change) =>
        `  Line ${change.lineNumber}: Change\n` +
        `    Before: ${change.before}\n` +
        `    After:  ${change.after}`,
    )
    .join("\n");

  return `Dry-run mode: No files will be modified.\n${lines}\n\n${changes.length} replacements would be made.`;
}
