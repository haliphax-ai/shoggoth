// -----------------------------------------------------------------------------
// builtin-replace — replace patterns in files
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatRegexError } from "../lib/error-utils";

export interface BuiltinReplaceParams {
  path: string;
  pattern?: string;
  replacement?: string;
  caseSensitive?: boolean;
  maxOccurrences?: number;
  dryRun?: boolean;
  deleteLines?: number[];
  deleteLine?: number; // Support singular for backward compatibility
  deleteRange?: { start: number; end: number };
  replaceRange?: { start: number; end: number };
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
    const deleteLine = args.deleteLine;
    const deleteRange = args.deleteRange;
    const replaceRange = args.replaceRange;

    // Resolve the full path
    const fullPath = resolve(ctx.workspacePath, path);

    // Check if path exists
    if (!existsSync(fullPath)) {
      throw new Error(`Path not found: ${path}`);
    }

    // Check if it's a file (not directory)
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      throw new Error(`Cannot replace in directory: ${path}`);
    }

    // Handle line-level operations first
    if (deleteLines || deleteLine || deleteRange) {
      // Convert singular deleteLine to array
      const linesToDelete = deleteLines || (deleteLine ? [deleteLine] : undefined);
      return await handleLineDeletion(fullPath, linesToDelete, deleteRange, dryRun);
    }

    if (replaceRange) {
      // For range replacement, use the replacement parameter or default to empty string
      const replacementContent = replacement || "";
      return await handleRangeReplacement(fullPath, replaceRange, replacementContent, dryRun);
    }

    // Handle regex replacement
    if (!pattern) {
      throw new Error("Pattern is required");
    }

    return await handleRegexReplacement(
      fullPath,
      pattern,
      replacement || "",
      caseSensitive,
      maxOccurrences,
      dryRun,
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(errorMessage);
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
        error: errorMessage,
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

    // Split content into lines, preserving line endings
    const lines = content.split("\n");
    const hasTrailingNewline = content.endsWith("\n");

    // If the last element is an empty string due to trailing newline, remove it
    // but we need to track whether to add it back later
    if (hasTrailingNewline && lines[lines.length - 1] === "") {
      lines.pop();
    }

    let deleteSet: Set<number>;
    let changesMade = 0;

    if (deleteLines) {
      // Validate and filter out-of-range line numbers
      const validLines = deleteLines.filter((ln) => ln >= 1 && ln <= lines.length);
      if (validLines.length !== deleteLines.length) {
        const invalidLines = deleteLines.filter((ln) => ln < 1 || ln > lines.length);
        throw new Error(
          `Invalid line numbers: ${invalidLines.join(", ")}. Total lines: ${lines.length}`,
        );
      }
      deleteSet = new Set(validLines);
      changesMade = deleteSet.size;
    } else if (deleteRange) {
      const { start, end } = deleteRange;
      if (start < 1 || end > lines.length) {
        throw new Error(`Out of range: start=${start}, end=${end}, totalLines=${lines.length}`);
      }
      if (start > end) {
        throw new Error(`Invalid range: start=${start} is greater than end=${end}`);
      }

      deleteSet = new Set(Array.from({ length: end - start + 1 }, (_, i) => start + i));
      changesMade = deleteSet.size;
    } else {
      throw new Error("No deletion parameters provided");
    }

    const newLines = lines.filter((_, i) => !deleteSet.has(i + 1));

    // Handle edge case: when all lines are deleted, result should be empty
    let newContent: string;
    if (newLines.length === 0) {
      newContent = "";
    } else {
      newContent = newLines.join("\n");
      // Preserve trailing newline if original had one
      if (hasTrailingNewline) {
        newContent += "\n";
      }
    }

    if (!dryRun) {
      writeFileSync(filePath, newContent, "utf-8");
    }

    const result: ReplaceResult = {
      modified: !dryRun,
      changesMade,
      deletedLines: changesMade,
    };

    if (dryRun && changesMade > 0) {
      result.preview = formatLineOperationsPreview(lines, deleteSet, "delete");
    }

    return {
      resultJson: JSON.stringify(result),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(errorMessage);
  }
}

async function handleRangeReplacement(
  filePath: string,
  replaceRange: { start: number; end: number },
  replacement: string,
  dryRun?: boolean,
): Promise<{ resultJson: string }> {
  try {
    const content = readFileSync(filePath, "utf-8");

    // Split content into lines, preserving line endings
    const lines = content.split("\n");
    const hasTrailingNewline = content.endsWith("\n");

    // If the last element is an empty string due to trailing newline, remove it
    if (hasTrailingNewline && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const { start, end } = replaceRange;

    if (start < 1 || end > lines.length) {
      throw new Error(`Out of range: start=${start}, end=${end}, totalLines=${lines.length}`);
    }
    if (start > end) {
      throw new Error(`Invalid range: start=${start} is greater than end=${end}`);
    }

    // Handle replacement as string or array
    const replacementLines = Array.isArray(replacement) ? replacement : [replacement];
    const changesMade = end - start + 1;

    const beforeLines = lines.slice(0, start - 1);
    const afterLines = lines.slice(end);
    const newLines = [...beforeLines, ...replacementLines, ...afterLines];

    // Handle edge case: when all lines are replaced with empty, result should be empty
    let newContent: string;
    if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
      newContent = "";
    } else {
      newContent = newLines.join("\n");
      // Preserve trailing newline if original had one
      if (hasTrailingNewline) {
        newContent += "\n";
      }
    }

    if (!dryRun) {
      writeFileSync(filePath, newContent, "utf-8");
    }

    const result: ReplaceResult = {
      modified: !dryRun,
      changesMade,
      replacedLines: changesMade,
    };

    if (dryRun && changesMade > 0) {
      result.preview = formatRangeReplacementPreview(lines, start, end, replacementLines);
    }

    return {
      resultJson: JSON.stringify(result),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(errorMessage);
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

function formatLineOperationsPreview(
  originalLines: string[],
  deletedSet: Set<number>,
  operation: "delete",
): string {
  const deletedLines = Array.from(deletedSet).sort((a, b) => a - b);
  const previewLines = deletedLines.map((lineNum) => {
    const content = originalLines[lineNum - 1];
    return `  Line ${lineNum}: ${operation === "delete" ? "Delete" : "Change"}\n    Content: ${content}`;
  });

  return `Dry-run mode: No files will be modified.\n${previewLines.join("\n")}\n\n${deletedLines.length} lines would be ${operation}d.`;
}

function formatRangeReplacementPreview(
  originalLines: string[],
  start: number,
  end: number,
  replacementLines: string[],
): string {
  const beforeLines = originalLines.slice(start - 1, end);
  const afterLines = replacementLines;

  let preview = `Dry-run mode: No files will be modified.\n`;
  preview += `  Lines ${start}-${end}: Replace\n`;
  preview += `    Before:\n`;
  beforeLines.forEach((line) => {
    preview += `      ${line}\n`;
  });
  preview += `    After:\n`;
  afterLines.forEach((line) => {
    preview += `      ${line}\n`;
  });
  preview += `\n${beforeLines.length} lines would be replaced with ${afterLines.length} lines.`;

  return preview;
}
