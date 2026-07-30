import { realpathSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { runAsUser, resolvePathForWrite } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { checkAgentsMdGate } from "../agents-md-gate";
import { formatRegexError } from "./regex-error-utils";

export type ChangedLine = { start: number; end: number } | { line: number };
export type ChangedLines = ChangedLine[];

export function register(registry: BuiltinToolRegistry): void {
  registry.register("replace", replaceHandler);
}

async function replaceHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  // AGENTS.md discovery gate
  const gateCwd = ctx.workingDirectory ?? ctx.workspacePath;
  const gate = checkAgentsMdGate(ctx.db, ctx.sessionId, gateCwd, ctx.workspacePath);
  if (gate) return { resultJson: JSON.stringify(gate) };

  // Extract and validate parameters
  const path = args.path as string;
  const pattern = args.pattern as string;
  const replacement = args.replacement as string;
  const caseSensitive = args.caseSensitive !== false; // default true
  const maxOccurrences = typeof args.maxOccurrences === "number" ? args.maxOccurrences : undefined;
  const dryRun = args.dryRun === true;
  const multiline = args.multiline === true; // default false
  const fixedStrings = args.fixedStrings === true; // default false

  // Parse unified deleteLines parameter (accepts: number, number[], or {start, end})
  const deleteLinesSet = new Set<number>();
  const deleteLinesInput = args.deleteLines;

  if (deleteLinesInput !== undefined) {
    if (typeof deleteLinesInput === "number") {
      // Single line number
      deleteLinesSet.add(deleteLinesInput);
    } else if (Array.isArray(deleteLinesInput)) {
      // Array of line numbers
      for (const n of deleteLinesInput) {
        if (typeof n === "number") {
          deleteLinesSet.add(n);
        }
      }
    } else if (typeof deleteLinesInput === "object" && deleteLinesInput !== null) {
      // Range object with start/end
      const range = deleteLinesInput as { start: number; end: number };
      if (typeof range.start === "number" && typeof range.end === "number") {
        for (let i = range.start; i <= range.end; i++) {
          deleteLinesSet.add(i);
        }
      }
    }
  }

  // Keep replaceRange as a separate parameter (not part of consolidation)
  const replaceRange = args.replaceRange as { start: number; end: number } | undefined;

  // Validate line numbers are 1-indexed
  const validateLineNumber = (n: number): boolean => {
    return Number.isInteger(n) && n >= 1;
  };

  // Validate deleteLines values
  for (const n of deleteLinesSet) {
    if (!validateLineNumber(n)) {
      return {
        resultJson: JSON.stringify({ error: "deleteLines values must be positive integers" }),
      };
    }
  }

  // Validate replaceRange
  if (replaceRange) {
    if (!validateLineNumber(replaceRange.start) || !validateLineNumber(replaceRange.end)) {
      return {
        resultJson: JSON.stringify({ error: "replaceRange start/end must be positive integers" }),
      };
    }
    if (replaceRange.start > replaceRange.end) {
      return {
        resultJson: JSON.stringify({ error: "replaceRange.start must be <= replaceRange.end" }),
      };
    }
  }

  // Resolve absolute path
  let absPath: string;
  try {
    absPath = resolvePathForWrite(ctx.workspacePath, resolveUserPath(ctx, path));
  } catch {
    return { resultJson: JSON.stringify({ error: "path escapes workspace" }) };
  }

  // Check if file exists
  try {
    const stat = statSync(absPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      return { resultJson: JSON.stringify({ error: "path does not exist or is not a file" }) };
    }
  } catch {
    return { resultJson: JSON.stringify({ error: "cannot access file" }) };
  }

  const cwd = realpathSync(ctx.workspacePath);
  const uid = ctx.creds.uid;
  const gid = ctx.creds.gid;

  // Pattern-based replacement (requires pattern and replacement unless line operations are specified)
  const hasLineOperations = deleteLinesSet.size > 0 || replaceRange;

  if (!hasLineOperations && !pattern) {
    return { resultJson: JSON.stringify({ error: "pattern is required for replacement" }) };
  }
  if (!hasLineOperations && !replacement) {
    return { resultJson: JSON.stringify({ error: "replacement is required" }) };
  }

  // Validate regex pattern early (only for pattern-based replacement, not for fixedStrings or line ops)
  if (!hasLineOperations && !fixedStrings && pattern) {
    try {
      new RegExp(pattern);
    } catch (e: any) {
      const errorData = formatRegexError(e, pattern);
      return { resultJson: JSON.stringify(errorData) };
    }
  }

  /**
   * Build a ChangedLine[] from a sorted, 1-indexed line number set.
   * Coalesces contiguous numbers into {start, end} ranges; isolated numbers stay {line: N}.
   */
  const buildChangedLines = (sortedOneIndexed: number[]): ChangedLines => {
    if (sortedOneIndexed.length === 0) return [];
    const result: ChangedLines = [];
    let rangeStart = sortedOneIndexed[0];
    let rangeEnd = sortedOneIndexed[0];
    for (let i = 1; i < sortedOneIndexed.length; i++) {
      const n = sortedOneIndexed[i];
      if (n === rangeEnd + 1) {
        rangeEnd = n;
      } else {
        if (rangeStart === rangeEnd) {
          result.push({ line: rangeStart });
        } else {
          result.push({ start: rangeStart, end: rangeEnd });
        }
        rangeStart = n;
        rangeEnd = n;
      }
    }
    if (rangeStart === rangeEnd) {
      result.push({ line: rangeStart });
    } else {
      result.push({ start: rangeStart, end: rangeEnd });
    }
    return result;
  };

  /**
   * Map a character offset within `content` to a 1-indexed line number.
   * Returns -1 if the offset is out of range.
   */
  const offsetToLineNumber = (content: string, offset: number): number => {
    if (offset < 0 || offset > content.length) return -1;
    let line = 1;
    for (let i = 0; i < offset; i++) {
      if (content.charCodeAt(i) === 10) line++; // 10 = "\n"
    }
    return line;
  };

  // Line operations (deleteLines) - always perform these first
  if (deleteLinesSet.size > 0) {
    // Read file lines
    const readResult = await runAsUser({
      file: process.execPath,
      args: [
        "-e",
        `const fs = require("fs"); const content = fs.readFileSync(${JSON.stringify(absPath)}, "utf8"); process.stdout.write(JSON.stringify(content.split("\\n")))`,
      ],
      cwd,
      uid,
      gid,
    });

    if (readResult.exitCode !== 0) {
      return {
        resultJson: JSON.stringify({
          error: readResult.stderr.trim() || "failed to read file",
        }),
      };
    }
    let lines: string[];
    try {
      lines = JSON.parse(readResult.stdout);
    } catch {
      return { resultJson: JSON.stringify({ error: "failed to parse file content" }) };
    }

    // Collect all line numbers to delete (1-indexed to 0-indexed)
    const linesToDelete = new Set<number>();
    deleteLinesSet.forEach((n) => linesToDelete.add(n - 1));

    const originalLineCount = lines.length;

    // Filter out lines (preserving trailing newlines behavior)
    const originalTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
    const newLines = lines.filter((_, idx) => !linesToDelete.has(idx));

    const newContent = originalTrailingNewline ? newLines.join("\n") + "\n" : newLines.join("\n");

    // Build changed_lines:
    // - The deleted lines themselves (as ranges or individual lines)
    // - The lines that shifted up because of the deletion (their new positions)
    const sortedDeleted = Array.from(linesToDelete)
      .sort((a, b) => a - b)
      .map((n) => n + 1);
    const changed_lines: ChangedLines = buildChangedLines(sortedDeleted);

    if (linesToDelete.size < originalLineCount) {
      // Compute the shift amount (positive = lines moved up by this many)
      const shiftAmount = linesToDelete.size;
      // For each line in the original that was NOT deleted, report its new
      // (post-shift) line number. These are the lines that visibly shifted.
      const shiftedNewLineNumbers: number[] = [];
      for (let i = 0; i < originalLineCount; i++) {
        if (!linesToDelete.has(i)) {
          shiftedNewLineNumbers.push(i + 1 - shiftAmount);
        }
      }
      for (const n of shiftedNewLineNumbers) {
        changed_lines.push({ line: n });
      }
    }

    if (dryRun) {
      return {
        resultJson: JSON.stringify({
          preview: newContent,
          linesDeleted: sortedDeleted,
          changed_lines,
        }),
      };
    }

    // Write back
    const writeResult = await runAsUser({
      file: process.execPath,
      args: ["-e", `require("fs").writeFileSync(${JSON.stringify(absPath)}, process.env.CONTENT)`],
      cwd,
      uid,
      gid,
      env: { CONTENT: newContent },
    });

    if (writeResult.exitCode !== 0) {
      return {
        resultJson: JSON.stringify({
          error: writeResult.stderr.trim() || "failed to write file",
        }),
      };
    }

    return {
      resultJson: JSON.stringify({
        success: true,
        linesDeleted: sortedDeleted,
        changed_lines,
      }),
    };
  }

  // Range replacement (replaceRange)
  if (replaceRange) {
    // Read file lines
    const readResult = await runAsUser({
      file: process.execPath,
      args: [
        "-e",
        `const fs = require("fs"); const content = fs.readFileSync(${JSON.stringify(absPath)}, "utf8"); process.stdout.write(JSON.stringify(content.split("\\n")))`,
      ],
      cwd,
      uid,
      gid,
    });

    if (readResult.exitCode !== 0) {
      return {
        resultJson: JSON.stringify({
          error: readResult.stderr.trim() || "failed to read file",
        }),
      };
    }

    let lines: string[];
    try {
      lines = JSON.parse(readResult.stdout);
    } catch {
      return { resultJson: JSON.stringify({ error: "failed to parse file content" }) };
    }

    const originalLineCount = lines.length;

    // Replace range (1-indexed to 0-indexed)
    const startIdx = replaceRange.start - 1;
    const endIdx = replaceRange.end - 1;

    if (startIdx >= lines.length) {
      return { resultJson: JSON.stringify({ error: "replaceRange.start is beyond file length" }) };
    }

    // Splice: remove range, insert replacement lines
    const replacementLines = replacement.split("\n");
    lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);

    const newContent = lines.join("\n");

    // Build changed_lines:

    // Build changed_lines:
    // - The new content range: positions replaceRange.start through
    //   replaceRange.start + replacementLines.length - 1
    // - If there were lines past the original replaced range, they shifted;
    //   the new range is (replaceRange.start + replacementLines.length)
    //   through (replaceRange.start + replacementLines.length + linesAfterReplace - 1)
    const changed_lines: ChangedLines = [
      { start: replaceRange.start, end: replaceRange.start + replacementLines.length - 1 },
    ];
    if (originalLineCount > endIdx + 1) {
      const linesAfterReplace = originalLineCount - replaceRange.end;
      const shiftedStart = replaceRange.start + replacementLines.length;
      const shiftedEnd = shiftedStart + linesAfterReplace - 1;
      changed_lines.push({ start: shiftedStart, end: shiftedEnd });
    }

    if (dryRun) {
      return {
        resultJson: JSON.stringify({ preview: newContent, changed_lines }),
      };
    }

    // Write back
    const writeResult = await runAsUser({
      file: process.execPath,
      args: ["-e", `require("fs").writeFileSync(${JSON.stringify(absPath)}, process.env.CONTENT)`],
      cwd,
      uid,
      gid,
      env: { CONTENT: newContent },
    });

    if (writeResult.exitCode !== 0) {
      return {
        resultJson: JSON.stringify({
          error: writeResult.stderr.trim() || "failed to write file",
        }),
      };
    }

    return { resultJson: JSON.stringify({ success: true, changed_lines }) };
  }

  // ── fixedStrings fast path: in-process, no rg, no subprocesses ──
  if (fixedStrings) {
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      return { resultJson: JSON.stringify({ error: "failed to read file" }) };
    }

    const maxReps = maxOccurrences ?? Infinity;
    const needleLen = pattern.length;
    const matchLineSet = new Set<number>();

    const performReplace = (
      haystack: string,
      needle: string,
    ): { result: string; replacements: number } => {
      let replacements = 0;
      let pos = 0;
      let result = "";
      while (replacements < maxReps) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;
        result += haystack.slice(pos, idx) + replacement;
        pos = idx + needleLen;
        replacements++;
        const lineNum = offsetToLineNumber(haystack, idx);
        if (lineNum > 0) matchLineSet.add(lineNum);
      }
      result += haystack.slice(pos);
      return { result, replacements };
    };

    let replacements: number;
    let result: string;
    if (caseSensitive) {
      ({ result, replacements } = performReplace(content, pattern));
    } else {
      const lowerContent = content.toLowerCase();
      const lowerPattern = pattern.toLowerCase();
      ({ result, replacements } = performReplace(lowerContent, lowerPattern));
    }

    if (replacements === 0) {
      return { resultJson: JSON.stringify({ replacements: 0, changed_lines: [] }) };
    }

    const changed_lines = buildChangedLines(Array.from(matchLineSet).sort((a, b) => a - b));

    if (dryRun) {
      return { resultJson: JSON.stringify({ preview: result, replacements, changed_lines }) };
    }

    try {
      writeFileSync(absPath, result, "utf8");
    } catch {
      return { resultJson: JSON.stringify({ error: "failed to write file" }) };
    }
    return { resultJson: JSON.stringify({ replacements, changed_lines }) };
  }

  // ── Standard regex path: rg for counting + safety limit ──
  const countArgs = ["--count-matches", "--no-filename"];
  if (!caseSensitive) countArgs.push("-i");
  if (multiline) countArgs.push("--multiline");
  countArgs.push("--", pattern, absPath);
  const countResult = await runAsUser({
    file: "rg",
    args: countArgs,
    cwd,
    uid,
    gid,
  });

  if (countResult.exitCode === 2) {
    return {
      resultJson: JSON.stringify({
        error: countResult.stderr.trim() || "failed to read file",
      }),
    };
  }

  const totalMatches = parseInt(countResult.stdout.trim(), 10) || 0;

  // Early return when no matches found
  if (totalMatches === 0) {
    return {
      resultJson: JSON.stringify({ replacements: 0, changed_lines: [] }),
    };
  }

  if (totalMatches > 1000) {
    return {
      resultJson: JSON.stringify({
        error: `Safety limit exceeded: found ${totalMatches} matches (max 1000)`,
      }),
    };
  }

  // Get line numbers for changed_lines using rg with line numbers
  const lineArgs = ["--no-filename", "--line-number"];
  if (!caseSensitive) lineArgs.push("-i");
  if (multiline) lineArgs.push("--multiline");
  lineArgs.push("--", pattern, absPath);
  const lineResult = await runAsUser({
    file: "rg",
    args: lineArgs,
    cwd,
    uid,
    gid,
  });

  // Collect unique line numbers from rg output
  const matchLineSet = new Set<number>();
  if (lineResult.exitCode === 0) {
    const lineMatches = lineResult.stdout.trim().split("\n");
    for (const match of lineMatches) {
      const lineNum = parseInt(match.split(":")[0], 10);
      if (!isNaN(lineNum)) {
        matchLineSet.add(lineNum);
      }
    }
  }

  // Read file content
  const readResult = await runAsUser({
    file: process.execPath,
    args: [
      "-e",
      `process.stdout.write(require("fs").readFileSync(${JSON.stringify(absPath)}, "utf8"))`,
    ],
    cwd,
    uid,
    gid,
  });
  const content = readResult.stdout;
  const regexFlags = caseSensitive ? (multiline ? "gm" : "g") : multiline ? "gmi" : "gi";
  const regex = new RegExp(pattern, regexFlags);
  let replacements = 0;
  const maxReplacements = maxOccurrences ?? Infinity;
  const result = content.replace(regex, (match, ...rest) => {
    if (replacements >= maxReplacements) return match;
    replacements++;
    // Support $1..$9 capture group refs via the native replace
    return replacement.replace(/\$(\d)/g, (_, n) => rest[parseInt(n, 10) - 1] ?? _);
  });

  const changed_lines = buildChangedLines(Array.from(matchLineSet).sort((a, b) => a - b));

  if (dryRun) {
    return { resultJson: JSON.stringify({ preview: result, replacements, changed_lines }) };
  }

  // Write back
  const writeResult = await runAsUser({
    file: process.execPath,
    args: ["-e", `require("fs").writeFileSync(${JSON.stringify(absPath)}, process.env.CONTENT)`],
    cwd,
    uid,
    gid,
    env: { CONTENT: result },
  });

  if (writeResult.exitCode !== 0) {
    return {
      resultJson: JSON.stringify({
        error: writeResult.stderr.trim() || "failed to write file",
      }),
    };
  }

  return { resultJson: JSON.stringify({ replacements, changed_lines }) };
}
