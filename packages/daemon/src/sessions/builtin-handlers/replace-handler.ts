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

  // Line operations (deleteLines)
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

    const newLines = lines.filter((_, idx) => !linesToDelete.has(idx));
    const newContent = newLines.join("\n");

    if (dryRun) {
      return {
        resultJson: JSON.stringify({
          preview: newContent,
          linesDeleted: Array.from(linesToDelete)
            .sort((a, b) => a - b)
            .map((n) => n + 1),
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
        linesDeleted: Array.from(linesToDelete)
          .sort((a, b) => a - b)
          .map((n) => n + 1),
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

    const startIdx = replaceRange.start - 1;
    const endIdx = replaceRange.end - 1;

    if (startIdx >= lines.length) {
      return { resultJson: JSON.stringify({ error: "replaceRange.start is beyond file length" }) };
    }

    const replacementLines = replacement.split("\n");
    lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
    const newContent = lines.join("\n");

    if (dryRun) {
      return { resultJson: JSON.stringify({ preview: newContent }) };
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

    return { resultJson: JSON.stringify({ success: true }) };
  }

  // ── fixedStrings fast path: in-process, no rg, no subprocesses ──
  if (fixedStrings) {
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      return { resultJson: JSON.stringify({ error: "failed to read file" }) };
    }

    if (caseSensitive) {
      const maxReps = maxOccurrences ?? Infinity;
      const needleLen = pattern.length;
      let replacements = 0;
      let pos = 0;
      let result = "";
      while (replacements < maxReps) {
        const idx = content.indexOf(pattern, pos);
        if (idx === -1) break;
        result += content.slice(pos, idx) + replacement;
        pos = idx + needleLen;
        replacements++;
      }
      result += content.slice(pos);

      if (replacements === 0) {
        return { resultJson: JSON.stringify({ replacements: 0 }) };
      }

      if (dryRun) {
        return { resultJson: JSON.stringify({ preview: result, replacements }) };
      }

      try {
        writeFileSync(absPath, result, "utf8");
      } catch {
        return { resultJson: JSON.stringify({ error: "failed to write file" }) };
      }
      if (beforeLineCount !== undefined) {
        maybeMarkReReadRequired(ctx, absPath, beforeLineCount);
      }
      return { resultJson: JSON.stringify({ replacements }) };
    }
    const maxReps = maxOccurrences ?? Infinity;
    const lowerContent = content.toLowerCase();
    const lowerPattern = pattern.toLowerCase();
    const needleLen = pattern.length;
    let replacements = 0;
    let pos = 0;
    let result = "";
    while (replacements < maxReps) {
      const idx = lowerContent.indexOf(lowerPattern, pos);
      if (idx === -1) break;
      result += content.slice(pos, idx) + replacement;
      pos = idx + needleLen;
      replacements++;
    }
    result += content.slice(pos);

    if (replacements === 0) {
      return { resultJson: JSON.stringify({ replacements: 0 }) };
    }

    if (dryRun) {
      return { resultJson: JSON.stringify({ preview: result, replacements }) };
    }

    try {
      writeFileSync(absPath, result, "utf8");
    } catch {
      return { resultJson: JSON.stringify({ error: "failed to write file" }) };
    }
    if (beforeLineCount !== undefined) {
      maybeMarkReReadRequired(ctx, absPath, beforeLineCount);
    }
    return { resultJson: JSON.stringify({ replacements }) };
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
      resultJson: JSON.stringify({ replacements: 0 }),
    };
  }

  if (totalMatches > 1000) {
    return {
      resultJson: JSON.stringify({
        error: `Safety limit exceeded: found ${totalMatches} matches (max 1000)`,
      }),
    };
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
    return replacement.replace(/\\$(\\d)/g, (_, n) => rest[parseInt(n, 10) - 1] ?? _);
  });

  if (dryRun) {
    return { resultJson: JSON.stringify({ preview: result, replacements }) };
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

  return { resultJson: JSON.stringify({ replacements }) };
}
