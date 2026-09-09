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

  // ── Mode detection ────────────────────────────────────────────────────────
  const isBatch = Array.isArray(args.edits);
  const hasStart = typeof args.start === "number";
  const hasEnd = typeof args.end === "number";
  const isPositional = hasStart || hasEnd;
  const isRegex = typeof args.pattern === "string";

  if (isBatch && isPositional) {
    return {
      resultJson: JSON.stringify({ error: "edits is mutually exclusive with start/end" }),
    };
  }
  if (isBatch && isRegex) {
    return {
      resultJson: JSON.stringify({ error: "edits is mutually exclusive with pattern" }),
    };
  }
  if (isPositional && isRegex) {
    return {
      resultJson: JSON.stringify({ error: "start/end is mutually exclusive with pattern" }),
    };
  }
  if (hasStart !== hasEnd) {
    return {
      resultJson: JSON.stringify({ error: "start and end must both be provided" }),
    };
  }

  // ── Positional edits mode (batch or single) ──────────────────────────────
  // All positional edits use the normalized format: { start, end, replacement? }
  // - replacement present → replace lines start..end with replacement content
  // - replacement absent → delete lines start..end
  if (isBatch || isPositional) {
    const dryRun = args.dryRun === true;

    // Build normalized edits array
    const edits: Array<{ start: number; end: number; replacement?: string }> = [];

    if (isBatch) {
      const batchEdits = args.edits as unknown[];
      if (batchEdits.length === 0) {
        return {
          resultJson: JSON.stringify({ error: "edits must be a non-empty array (max 50 entries)" }),
        };
      }
      if (batchEdits.length > 50) {
        return {
          resultJson: JSON.stringify({ error: "edits cannot exceed 50 entries" }),
        };
      }
      for (const raw of batchEdits as Array<Record<string, unknown>>) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          return {
            resultJson: JSON.stringify({ error: "each edits entry must be an object" }),
          };
        }
        if (typeof raw.start !== "number" || !Number.isInteger(raw.start) || raw.start < 1) {
          return {
            resultJson: JSON.stringify({ error: "edit start must be a positive integer" }),
          };
        }
        if (typeof raw.end !== "number" || !Number.isInteger(raw.end) || raw.end < 1) {
          return {
            resultJson: JSON.stringify({ error: "edit end must be a positive integer" }),
          };
        }
        if ((raw.start as number) > (raw.end as number)) {
          return {
            resultJson: JSON.stringify({ error: "edit start must be <= end" }),
          };
        }
        if (raw.replacement !== undefined && typeof raw.replacement !== "string") {
          return {
            resultJson: JSON.stringify({ error: "edit replacement must be a string if provided" }),
          };
        }
        edits.push({
          start: raw.start as number,
          end: raw.end as number,
          replacement: raw.replacement as string | undefined,
        });
      }
    } else {
      // Single positional edit
      const start = args.start as number;
      const end = args.end as number;
      if (!Number.isInteger(start) || start < 1) {
        return {
          resultJson: JSON.stringify({ error: "start must be a positive integer" }),
        };
      }
      if (!Number.isInteger(end) || end < 1) {
        return {
          resultJson: JSON.stringify({ error: "end must be a positive integer" }),
        };
      }
      if (start > end) {
        return {
          resultJson: JSON.stringify({ error: "start must be <= end" }),
        };
      }
      if (args.replacement !== undefined && typeof args.replacement !== "string") {
        return {
          resultJson: JSON.stringify({ error: "replacement must be a string if provided" }),
        };
      }
      edits.push({
        start,
        end,
        replacement: args.replacement as string | undefined,
      });
    }

    // Resolve absolute path
    let absPath: string;
    try {
      absPath = resolvePathForWrite(ctx.workspacePath, resolveUserPath(ctx, args.path as string));
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

    // Read file into a lines array
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

    // Validate line ranges against file length
    for (const edit of edits) {
      if (edit.start > originalLineCount || edit.end > originalLineCount) {
        return {
          resultJson: JSON.stringify({ error: "line range is beyond file length" }),
        };
      }
    }

    // Reject overlapping line ranges (checked against ORIGINAL line numbers)
    const byStart = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < byStart.length; i++) {
      if (byStart[i].start <= byStart[i - 1].end) {
        return {
          resultJson: JSON.stringify({ error: "edits contain overlapping line ranges" }),
        };
      }
    }

    // Apply edits bottom-up: highest applicable line number first
    const sortedEdits = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
    const workLines = lines.slice();
    for (const edit of sortedEdits) {
      const startIdx = edit.start - 1;
      const endIdx = edit.end - 1;
      const replacementLines = edit.replacement !== undefined ? edit.replacement.split("\n") : [];
      workLines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
    }
    const newContent = workLines.join("\n");
    const editsApplied = edits.length;

    // Compute changed_lines: track where each edit's content ended up
    const ascEdits = [...edits].sort((a, b) => a.start - b.start);
    let cumShift = 0;
    const changedLines: ChangedLines = [];
    for (const edit of ascEdits) {
      const origLen = edit.end - edit.start + 1;
      const isDelete = edit.replacement === undefined;
      const replLen = isDelete ? 0 : edit.replacement!.split("\n").length;

      if (!isDelete) {
        const newStart = edit.start + cumShift;
        const newEnd = newStart + replLen - 1;
        changedLines.push({ start: newStart, end: newEnd });
      }

      cumShift += replLen - origLen;
    }

    // For single edits, also include shifted lines after the edit
    if (edits.length === 1) {
      const edit = edits[0];
      const isDelete = edit.replacement === undefined;
      const replLen = isDelete ? 0 : edit.replacement!.split("\n").length;
      const linesAfter = originalLineCount - edit.end;
      if (linesAfter > 0) {
        const shiftedStart = edit.start + replLen;
        const shiftedEnd = shiftedStart + linesAfter - 1;
        changedLines.push({ start: shiftedStart, end: shiftedEnd });
      }
    }

    if (dryRun) {
      return {
        resultJson: JSON.stringify({
          success: true,
          edits_applied: editsApplied,
          changed_lines: changedLines,
          preview: newContent,
        }),
      };
    }

    // Write file
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
        changed_lines: changedLines,
      }),
    };
  }

  // ── Regex mode ───────────────────────────────────────────────────────────
  // Extract and validate parameters
  const path = args.path as string;
  const pattern = args.pattern as string;
  const replacement = args.replacement as string;
  const caseSensitive = args.caseSensitive !== false; // default true
  const maxOccurrences = typeof args.maxOccurrences === "number" ? args.maxOccurrences : undefined;
  const dryRun = args.dryRun === true;
  const multiline = args.multiline === true; // default false
  const fixedStrings = args.fixedStrings === true; // default false

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

  if (!pattern) {
    return { resultJson: JSON.stringify({ error: "pattern is required for replacement" }) };
  }
  if (!replacement) {
    return { resultJson: JSON.stringify({ error: "replacement is required" }) };
  }

  if (!fixedStrings && pattern) {
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
    return { resultJson: JSON.stringify({ replacements: 0, changed_lines: [] }) };
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
