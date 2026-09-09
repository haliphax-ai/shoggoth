import { realpathSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { runAsUser, resolvePathForWrite } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { checkAgentsMdGate } from "../agents-md-gate";
import {
  checkReReadRequired,
  markReReadRequired,
  type ReReadRequiredGate,
} from "../re-read-required";
import { getSessionContextSegmentId } from "../session-store";
import { formatRegexError } from "./regex-error-utils";

/**
 * Count lines in `text` using the same split as `builtin-read`, so the
 * "did line numbers shift?" check is consistent with the line numbers the
 * agent sees when it reads the file.
 */
function countLines(text: string): number {
  return text.split(/\r\n|\n|\r/).length;
}

/**
 * Whether `ctx.db` looks like a real better-sqlite3 handle. Stub dbs (in
 * unit tests for unrelated paths) make the re-read gate a no-op.
 */
function hasRealDb(ctx: BuiltinToolContext): boolean {
  return typeof (ctx.db as { prepare?: unknown })?.prepare === "function";
}

/**
 * Consumer gate: if `absPath` is flagged for re-read in the current segment,
 * return a gate result payload. Otherwise return null. Best-effort: returns
 * null on any internal error so a stub db does not break the handler.
 */
function reReadGate(ctx: BuiltinToolContext, absPath: string): ReReadRequiredGate | null {
  if (!hasRealDb(ctx)) return null;
  try {
    const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
    return checkReReadRequired(ctx.db, ctx.sessionId, segmentId, absPath);
  } catch {
    return null;
  }
}

/**
 * Producer: if the on-disk line count changed, flag the file for re-read.
 * No-op for dry runs, when the count is unchanged, or when the db is a stub.
 */
function maybeMarkReReadRequired(
  ctx: BuiltinToolContext,
  absPath: string,
  beforeLineCount: number,
): void {
  if (!hasRealDb(ctx)) return;
  let after: number;
  try {
    after = countLines(readFileSync(absPath, "utf8"));
  } catch {
    return;
  }
  if (after === beforeLineCount) return;
  try {
    const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
    markReReadRequired(ctx.db, ctx.sessionId, segmentId, absPath);
  } catch {
    // ignore
  }
}

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

  // ── Batch edits mode ────────────────────────────────────────────────────
  // Applies multiple edits referencing ORIGINAL line numbers in a single
  // call. Edits are sorted bottom-up (highest line first) so earlier edits
  // do not shift the line numbers of later edits.
  if (args.edits !== undefined) {
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return {
        resultJson: JSON.stringify({ error: "edits must be a non-empty array (max 50 entries)" }),
      };
    }
    if (args.edits.length > 50) {
      return {
        resultJson: JSON.stringify({ error: "edits cannot exceed 50 entries" }),
      };
    }
    if (
      args.pattern !== undefined ||
      args.deleteLines !== undefined ||
      args.replaceRange !== undefined
    ) {
      return {
        resultJson: JSON.stringify({
          error: "edits is mutually exclusive with pattern, deleteLines, and replaceRange",
        }),
      };
    }

    const path = args.path as string;
    const dryRun = args.dryRun === true;

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

    // Re-read gate (consumer) and capture line count for producer
    let beforeLineCount: number | undefined;
    if (!dryRun) {
      const reReadResult = reReadGate(ctx, absPath);
      if (reReadResult) {
        return { resultJson: JSON.stringify(reReadResult) };
      }
      try {
        beforeLineCount = countLines(readFileSync(absPath, "utf8"));
      } catch {
        beforeLineCount = undefined;
      }
    }

    const cwd = realpathSync(ctx.workspacePath);
    const uid = ctx.creds.uid;
    const gid = ctx.creds.gid;

    // Read file into a lines array using runAsUser (same pattern as deleteLines)
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

    interface BatchEdit {
      kind: "replace" | "delete";
      /** 1-indexed first affected line (for replace: start; for delete: min line). */
      start: number;
      /** 1-indexed last affected line (for replace: end; for delete: max line). */
      end: number;
      replacement?: string;
      /** 1-indexed line numbers to delete (delete edits only). */
      deleteLines: number[];
    }

    const applied: BatchEdit[] = [];
    const validateInteger = (n: unknown, _field: string): n is number => {
      return typeof n === "number" && Number.isInteger(n) && n >= 1;
    };
    const beyondError = (field: string) =>
      ({ resultJson: JSON.stringify({ error: `${field} is beyond file length` }) }) as const;

    for (const raw of args.edits as Array<Record<string, unknown>>) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { resultJson: JSON.stringify({ error: "each edits entry must be an object" }) };
      }

      // Replace edit — test form: { replaceRange: {start, end}, replacement }
      const rr = raw.replaceRange as { start?: unknown; end?: unknown } | undefined;
      if (rr !== undefined) {
        if (!validateInteger(rr.start, "start") || !validateInteger(rr.end, "end")) {
          return {
            resultJson: JSON.stringify({
              error: "edit replaceRange start/end must be positive integers",
            }),
          };
        }
        if (rr.start > rr.end) {
          return {
            resultJson: JSON.stringify({
              error: "edit replaceRange.start must be <= replaceRange.end",
            }),
          };
        }
        if (rr.start > originalLineCount || rr.end > originalLineCount) {
          return beyondError("edit line range");
        }
        if (typeof raw.replacement !== "string") {
          return {
            resultJson: JSON.stringify({ error: "replacement is required for replace edits" }),
          };
        }
        applied.push({
          kind: "replace",
          start: rr.start,
          end: rr.end,
          replacement: raw.replacement,
          deleteLines: [],
        });
        continue;
      }

      // Replace edit — schema form: { type: "replace", start, end, replacement }
      if (raw.type === "replace" || raw.start !== undefined || raw.end !== undefined) {
        if (!validateInteger(raw.start, "start") || !validateInteger(raw.end, "end")) {
          return {
            resultJson: JSON.stringify({
              error: "edit start/end must be positive integers",
            }),
          };
        }
        if ((raw.start as number) > (raw.end as number)) {
          return {
            resultJson: JSON.stringify({ error: "edit start must be <= end" }),
          };
        }
        if ((raw.start as number) > originalLineCount || (raw.end as number) > originalLineCount) {
          return beyondError("edit line range");
        }
        if (typeof raw.replacement !== "string") {
          return {
            resultJson: JSON.stringify({ error: "replacement is required for replace edits" }),
          };
        }
        applied.push({
          kind: "replace",
          start: raw.start as number,
          end: raw.end as number,
          replacement: raw.replacement,
          deleteLines: [],
        });
        continue;
      }

      // Delete edit — test form: { deleteLines: n | n[] | {start, end} }
      const dl = raw.deleteLines;
      if (dl !== undefined) {
        const deleteSet = new Set<number>();
        if (typeof dl === "number") {
          deleteSet.add(dl);
        } else if (Array.isArray(dl)) {
          for (const n of dl) {
            if (typeof n === "number") deleteSet.add(n);
          }
        } else if (typeof dl === "object" && dl !== null) {
          const range = dl as { start?: unknown; end?: unknown };
          if (validateInteger(range.start, "start") && validateInteger(range.end, "end")) {
            for (let i = range.start; i <= (range.end as number); i++) deleteSet.add(i);
          }
        }
        if (deleteSet.size === 0) {
          return {
            resultJson: JSON.stringify({
              error: "deleteLines edit must specify at least one valid line",
            }),
          };
        }
        const sortedLines = Array.from(deleteSet).sort((a, b) => a - b);
        for (const n of sortedLines) {
          if (n > originalLineCount) return beyondError("deleteLines edit line");
        }
        applied.push({
          kind: "delete",
          start: sortedLines[0],
          end: sortedLines[sortedLines.length - 1],
          deleteLines: sortedLines,
        });
        continue;
      }

      // Delete edit — schema form: { type: "delete", line | lines | range }
      if (
        raw.type === "delete" ||
        raw.line !== undefined ||
        raw.lines !== undefined ||
        raw.range !== undefined
      ) {
        const deleteSet = new Set<number>();
        if (validateInteger(raw.line, "line")) {
          deleteSet.add(raw.line);
        }
        if (Array.isArray(raw.lines)) {
          for (const n of raw.lines) {
            if (validateInteger(n, "lines")) deleteSet.add(n);
          }
        }
        if (typeof raw.range === "object" && raw.range !== null) {
          const range = raw.range as { start?: unknown; end?: unknown };
          if (validateInteger(range.start, "start") && validateInteger(range.end, "end")) {
            for (let i = range.start; i <= (range.end as number); i++) deleteSet.add(i);
          }
        }
        if (deleteSet.size === 0) {
          return {
            resultJson: JSON.stringify({
              error: "delete edit must specify at least one valid line",
            }),
          };
        }
        const sortedLines = Array.from(deleteSet).sort((a, b) => a - b);
        for (const n of sortedLines) {
          if (n > originalLineCount) return beyondError("delete edit line");
        }
        applied.push({
          kind: "delete",
          start: sortedLines[0],
          end: sortedLines[sortedLines.length - 1],
          deleteLines: sortedLines,
        });
        continue;
      }

      return {
        resultJson: JSON.stringify({
          error:
            "invalid edits entry: expected replace (start/end/replacement) or delete (line/lines/range)",
        }),
      };
    }

    // Reject overlapping line ranges (checked against ORIGINAL line numbers)
    const byStart = [...applied].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < byStart.length; i++) {
      if (byStart[i].start <= byStart[i - 1].end) {
        return {
          resultJson: JSON.stringify({
            error: "edits contain overlapping line ranges",
          }),
        };
      }
    }

    // Apply edits bottom-up: highest applicable line number first
    const sortedEdits = [...applied].sort((a, b) => b.start - a.start || b.end - a.end);
    const workLines = lines.slice();
    for (const edit of sortedEdits) {
      if (edit.kind === "replace") {
        const startIdx = edit.start - 1;
        const endIdx = edit.end - 1;
        workLines.splice(startIdx, endIdx - startIdx + 1, ...(edit.replacement ?? "").split("\n"));
      } else {
        const delSet = new Set(edit.deleteLines.map((n) => n - 1));
        const kept: string[] = [];
        for (let i = 0; i < workLines.length; i++) {
          if (!delSet.has(i)) kept.push(workLines[i]);
        }
        workLines.length = 0;
        workLines.push(...kept);
      }
    }
    const newContent = workLines.join("\n");
    const editsApplied = applied.length;

    if (dryRun) {
      return {
        resultJson: JSON.stringify({
          success: true,
          edits_applied: editsApplied,
          preview: newContent,
        }),
      };
    }

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
    if (beforeLineCount !== undefined) {
      maybeMarkReReadRequired(ctx, absPath, beforeLineCount);
    }

    return {
      resultJson: JSON.stringify({
        success: true,
        edits_applied: editsApplied,
      }),
    };
  }

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
      deleteLinesSet.add(deleteLinesInput);
    } else if (Array.isArray(deleteLinesInput)) {
      for (const n of deleteLinesInput) {
        if (typeof n === "number") {
          deleteLinesSet.add(n);
        }
      }
    } else if (typeof deleteLinesInput === "object" && deleteLinesInput !== null) {
      const range = deleteLinesInput as { start: number; end: number };
      if (typeof range.start === "number" && typeof range.end === "number") {
        for (let i = range.start; i <= range.end; i++) {
          deleteLinesSet.add(i);
        }
      }
    }
  }

  const replaceRange = args.replaceRange as { start: number; end: number } | undefined;

  const validateLineNumber = (n: number): boolean => {
    return Number.isInteger(n) && n >= 1;
  };

  for (const n of deleteLinesSet) {
    if (!validateLineNumber(n)) {
      return {
        resultJson: JSON.stringify({ error: "deleteLines values must be positive integers" }),
      };
    }
  }

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

  // Re-read gate (consumer) and capture line count for producer
  let beforeLineCount: number | undefined;
  if (!dryRun) {
    const reReadResult = reReadGate(ctx, absPath);
    if (reReadResult) {
      return { resultJson: JSON.stringify(reReadResult) };
    }
    try {
      beforeLineCount = countLines(readFileSync(absPath, "utf8"));
    } catch {
      beforeLineCount = undefined;
    }
  }

  const cwd = realpathSync(ctx.workspacePath);
  const uid = ctx.creds.uid;
  const gid = ctx.creds.gid;

  const hasLineOperations = deleteLinesSet.size > 0 || replaceRange;

  if (!hasLineOperations && !pattern) {
    return { resultJson: JSON.stringify({ error: "pattern is required for replacement" }) };
  }
  if (!hasLineOperations && !replacement) {
    return { resultJson: JSON.stringify({ error: "replacement is required" }) };
  }

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

    const linesToDelete = new Set<number>();
    deleteLinesSet.forEach((n) => linesToDelete.add(n - 1));

    const originalLineCount = lines.length;
    const newLines = lines.filter((_, idx) => !linesToDelete.has(idx));
    const newContent = newLines.join("\n");

    const sortedDeleted = Array.from(linesToDelete)
      .sort((a, b) => a - b)
      .map((n) => n + 1);
    const changed_lines: ChangedLines = buildChangedLines(sortedDeleted);

    if (linesToDelete.size < originalLineCount) {
      const shiftAmount = linesToDelete.size;
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
          replacements: linesToDelete.size,
          linesDeleted: sortedDeleted,
          changed_lines,
        }),
      };
    }

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
    if (beforeLineCount !== undefined) {
      maybeMarkReReadRequired(ctx, absPath, beforeLineCount);
    }

    return {
      resultJson: JSON.stringify({
        success: true,
        replacements: linesToDelete.size,
        linesDeleted: sortedDeleted,
        changed_lines,
      }),
    };
  }

  // Range replacement (replaceRange)
  if (replaceRange) {
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
    const startIdx = replaceRange.start - 1;
    const endIdx = replaceRange.end - 1;

    if (startIdx >= lines.length) {
      return { resultJson: JSON.stringify({ error: "replaceRange.start is beyond file length" }) };
    }

    const replacementLines = replacement.split("\n");
    lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
    const newContent = lines.join("\n");

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
        resultJson: JSON.stringify({ preview: newContent, replacements: 1, changed_lines }),
      };
    }

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
    if (beforeLineCount !== undefined) {
      maybeMarkReReadRequired(ctx, absPath, beforeLineCount);
    }

    return { resultJson: JSON.stringify({ success: true, replacements: 1, changed_lines }) };
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
    if (beforeLineCount !== undefined) {
      maybeMarkReReadRequired(ctx, absPath, beforeLineCount);
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
    return replacement.replace(/\\$(\d)/g, (_, n) => rest[parseInt(n, 10) - 1] ?? _);
  });

  const changed_lines = buildChangedLines(Array.from(matchLineSet).sort((a, b) => a - b));

  if (dryRun) {
    return { resultJson: JSON.stringify({ preview: result, replacements, changed_lines }) };
  }

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
  if (beforeLineCount !== undefined) {
    maybeMarkReReadRequired(ctx, absPath, beforeLineCount);
  }

  return { resultJson: JSON.stringify({ replacements, changed_lines }) };
}
