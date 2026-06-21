import { realpathSync, statSync } from "node:fs";
import { runAsUser, resolvePathForWrite } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { checkAgentsMdGate } from "../agents-md-gate";
import { formatRegexError } from "./regex-error-utils";

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

  // Validate regex pattern early
  try {
    new RegExp(pattern);
  } catch (e: any) {
    const errorData = formatRegexError(e, pattern);
    return { resultJson: JSON.stringify(errorData) };
  }

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

    // Filter out lines (preserving trailing newlines behavior)
    const originalTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
    const newLines = lines.filter((_, idx) => !linesToDelete.has(idx));

    const newContent = originalTrailingNewline ? newLines.join("\n") + "\n" : newLines.join("\n");

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
        linesDeleted: Array.from(linesToDelete)
          .sort((a, b) => a - b)
          .map((n) => n + 1),
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

    if (dryRun) {
      return { resultJson: JSON.stringify({ preview: newContent }) };
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

    return { resultJson: JSON.stringify({ success: true }) };
  }

  // Check for matches to warn about safety limit (>1000)
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

  if (totalMatches > 1000) {
    return {
      resultJson: JSON.stringify({
        error: `Safety limit exceeded: found ${totalMatches} matches (max 1000)`,
      }),
    };
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

  if (dryRun) {
    return { resultJson: JSON.stringify({ preview: result, replacements }) };
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

  return { resultJson: JSON.stringify({ replacements }) };
}
