// -----------------------------------------------------------------------------
// builtin-search — search files using ripgrep (rg)
// -----------------------------------------------------------------------------

import { statSync } from "node:fs";
import { dirname, basename } from "node:path";
import { runAsUser, resolvePathForRead } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { formatRegexError } from "./regex-error-utils";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("search", searchHandler);
}

interface SearchResult {
  filePath: string;
  lineNumber: number;
  context: string;
  matchedText: string;
}

async function searchHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const pattern = args.pattern as string;
  if (!pattern) {
    return { resultJson: JSON.stringify({ error: "pattern is required" }) };
  }

  // Validate regex pattern
  try {
    new RegExp(pattern);
  } catch (e: any) {
    const errorData = formatRegexError(e, pattern);
    return { resultJson: JSON.stringify(errorData) };
  }

  // Resolve and validate path
  let searchPath: string;
  try {
    searchPath = resolvePathForRead(
      ctx.workspacePath,
      resolveUserPath(ctx, String(args.path ?? ".")),
    );
  } catch {
    return { resultJson: JSON.stringify({ error: "path escapes workspace" }) };
  }

  const maxResults = typeof args.maxResults === "number" ? args.maxResults : 100;
  const caseSensitive = args.caseSensitive !== false; // default true
  const contextLines = typeof args.contextLines === "number" ? args.contextLines : 0;

  const rgArgs: string[] = ["--no-heading", "--line-number", "--color", "never"];

  if (!caseSensitive) rgArgs.push("-i");
  if (contextLines > 0) rgArgs.push("-C", String(contextLines));

  // Handle file vs directory paths
  let isFile = false;
  try {
    isFile = statSync(searchPath, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    // If stat fails, treat as directory
    isFile = false;
  }

  const rgCwd = isFile ? dirname(searchPath) : searchPath;
  const rgTarget = isFile ? basename(searchPath) : ".";
  rgArgs.push("--", pattern, rgTarget);

  const r = await runAsUser({
    file: "rg",
    args: rgArgs,
    cwd: rgCwd,
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
  });

  // rg exit 1 = no matches, exit 2 = error
  if (r.exitCode === 2) {
    return {
      resultJson: JSON.stringify({ error: r.stderr.trim() || "rg error" }),
    };
  }

  // Parse output
  const lines = r.stdout.split("\n").filter((line) => line.trim().length > 0);
  const matches: SearchResult[] = [];

  for (const line of lines) {
    if (isFile) {
      // rg --no-heading on single file outputs: lineNum:content
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;
      const lineNumberStr = line.slice(0, colonIndex);
      const lineNumber = parseInt(lineNumberStr, 10);
      if (isNaN(lineNumber)) continue;
      const matchedText = line.slice(colonIndex + 1);
      matches.push({
        filePath: basename(searchPath),
        lineNumber,
        context: matchedText,
        matchedText,
      });
    } else {
      // rg output format: filePath:lineNumber:content
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;
      const pathEndIndex = line.indexOf(":", colonIndex + 1);
      if (pathEndIndex === -1) continue;
      const filePath = line.slice(0, colonIndex);
      const lineNumberStr = line.slice(colonIndex + 1, pathEndIndex);
      const lineNumber = parseInt(lineNumberStr, 10);
      if (isNaN(lineNumber)) continue;
      const matchedText = line.slice(pathEndIndex + 1);
      const relativePath = filePath.replace(rgCwd + "/", "");
      matches.push({
        filePath: relativePath,
        lineNumber,
        context: matchedText,
        matchedText,
      });
    }
  }

  // Truncate to maxResults
  const truncated = matches.length > maxResults;
  const finalMatches = matches.slice(0, maxResults);

  const result: { matches: SearchResult[]; totalMatches: number; truncated?: boolean } = {
    matches: finalMatches,
    totalMatches: matches.length,
  };
  if (truncated) {
    result.truncated = true;
  }

  return { resultJson: JSON.stringify(result) };
}