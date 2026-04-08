// ---------------------------------------------------------------------------
// builtin-search-replace — search (via rg) and replace text in files
// ---------------------------------------------------------------------------

import { realpathSync, statSync } from "node:fs";
import { relative, resolve, isAbsolute, sep, dirname, basename } from "node:path";
import { runAsUser } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { checkAgentsMdGate } from "../agents-md-gate";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("search-replace", searchReplaceHandler);
}

function resolveAndGuard(workspaceRoot: string, userPath: string): string {
  if (userPath.includes("\0")) throw new Error("path escapes workspace");
  const rootReal = realpathSync(workspaceRoot);
  const abs = isAbsolute(userPath) ? userPath : resolve(rootReal, userPath);
  const rel = relative(rootReal, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("path escapes workspace");
  }
  return abs;
}

async function searchReplaceHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const action = args.action as string;
  if (action === "search") return handleSearch(args, ctx);
  if (action === "replace") return handleReplace(args, ctx);
  return { resultJson: JSON.stringify({ error: `unknown action: ${action}` }) };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function handleSearch(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const pattern = args.pattern as string;
  if (!pattern) return { resultJson: JSON.stringify({ error: "pattern is required" }) };

  let searchPath: string;
  try {
    searchPath = resolveAndGuard(ctx.workspacePath, resolveUserPath(ctx, String(args.path ?? ".")));
  } catch {
    return { resultJson: JSON.stringify({ error: "path escapes workspace" }) };
  }

  const maxResults = typeof args.maxResults === "number" ? args.maxResults : 200;

  const rgArgs: string[] = ["--no-heading", "--line-number", "--color", "never"];

  if (args.caseSensitive === false) rgArgs.push("-i");
  if (args.fixedStrings === true) rgArgs.push("-F");
  if (args.multiline === true) rgArgs.push("--multiline");
  if (args.includeHidden === true) rgArgs.push("--hidden");
  if (typeof args.fileType === "string") rgArgs.push("-t", args.fileType as string);
  if (typeof args.glob === "string") rgArgs.push("-g", args.glob as string);
  if (typeof args.contextLines === "number") rgArgs.push("-C", String(args.contextLines));
  if (typeof args.maxCount === "number") rgArgs.push("-m", String(args.maxCount));

  // Handle file vs directory paths
  const isFile = statSync(searchPath, { throwIfNoEntry: false })?.isFile() ?? false;
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
    return { resultJson: JSON.stringify({ error: r.stderr.trim() || "rg error" }) };
  }

  const lines = r.stdout.split("\n");
  let truncated = false;
  let output: string;
  if (lines.length > maxResults) {
    truncated = true;
    output = lines.slice(0, maxResults).join("\n") + `\n... truncated (${lines.length} total lines)`;
  } else {
    output = r.stdout;
  }

  return { resultJson: JSON.stringify({ output, truncated }) };
}

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

async function handleReplace(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  // AGENTS.md discovery gate
  const gateCwd = ctx.workingDirectory ?? ctx.workspacePath;
  const gate = checkAgentsMdGate(ctx.db, ctx.sessionId, gateCwd, ctx.workspacePath);
  if (gate) return { resultJson: JSON.stringify(gate) };

  const file = args.file as string;
  const match = args.match as string;
  const replacement = args.replacement as string;
  const fixedStrings = args.fixedStrings === true;
  const multiline = args.multiline === true;
  if (!file || match == null || replacement == null) {
    return { resultJson: JSON.stringify({ error: "file, match, and replacement are required" }) };
  }

  // Validate regex early (skip when fixedStrings mode)
  if (!fixedStrings) {
    try { new RegExp(match); } catch (e: any) {
      return { resultJson: JSON.stringify({ error: `invalid regex: ${e.message}` }) };
    }
  }

  // For regex operations in JS, escape the match when fixedStrings is set.
  const regexPattern = fixedStrings ? match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : match;

  let absPath: string;
  try {
    absPath = resolveAndGuard(ctx.workspacePath, resolveUserPath(ctx, file));
  } catch {
    return { resultJson: JSON.stringify({ error: "path escapes workspace" }) };
  }

  const cwd = realpathSync(ctx.workspacePath);
  const hasCount = typeof args.count === "number";

  // Step 1: check for matches via rg --count-matches
  const countArgs = ["--count-matches", "--no-filename"];
  if (fixedStrings) countArgs.push("-F");
  if (multiline) countArgs.push("--multiline");
  countArgs.push("--", match, absPath);
  const countResult = await runAsUser({
    file: "rg",
    args: countArgs,
    cwd,
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
  });

  if (countResult.exitCode === 2) {
    return { resultJson: JSON.stringify({ error: countResult.stderr.trim() || "failed to read file" }) };
  }

  const totalMatches = parseInt(countResult.stdout.trim(), 10) || 0;
  if (totalMatches === 0) {
    return { resultJson: JSON.stringify({ error: "match not found in file" }) };
  }

  // Step 2a: count-limited or multiline replacement — read, replace in JS, write back
  // (rg --passthru doesn't handle multiline replacements correctly)
  if (hasCount || multiline) {
    const readResult = await runAsUser({
      file: process.execPath,
      args: ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(absPath)}, "utf8"))`],
      cwd,
      uid: ctx.creds.uid,
      gid: ctx.creds.gid,
    });
    if (readResult.exitCode !== 0) {
      return { resultJson: JSON.stringify({ error: readResult.stderr.trim() || "failed to read file" }) };
    }

    const count = args.count as number;
    const maxReplacements = hasCount ? (count === 0 ? Infinity : count) : Infinity;
    let replacements = 0;
    const regexFlags = multiline ? "gs" : "g";
    const result = readResult.stdout.replace(new RegExp(regexPattern, regexFlags), (m, ...rest) => {
      if (replacements >= maxReplacements) return m;
      replacements++;
      if (fixedStrings) return replacement;
      // Support $1..$9 capture group refs via the native replace
      return replacement.replace(/\$(\d)/g, (_, n) => rest[parseInt(n, 10) - 1] ?? _);
    });

    const writeResult = await runAsUser({
      file: process.execPath,
      args: ["-e", `require("fs").writeFileSync(${JSON.stringify(absPath)}, process.env.SR_CONTENT)`],
      cwd,
      uid: ctx.creds.uid,
      gid: ctx.creds.gid,
      env: { SR_CONTENT: result },
    });
    if (writeResult.exitCode !== 0) {
      return { resultJson: JSON.stringify({ error: writeResult.stderr.trim() || "failed to write file" }) };
    }
    return { resultJson: JSON.stringify({ replacements }) };
  }

  // Step 2b: full replacement via rg --passthru --replace
  const rgReplaceArgs = ["--passthru", "--no-line-number", "--no-filename", "--color", "never"];
  if (fixedStrings) rgReplaceArgs.push("-F");
  if (multiline) rgReplaceArgs.push("--multiline");
  rgReplaceArgs.push("--replace", replacement, "--", match, absPath);
  const rgResult = await runAsUser({
    file: "rg",
    args: rgReplaceArgs,
    cwd,
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
  });

  if (rgResult.exitCode !== 0 && rgResult.exitCode !== 1) {
    return { resultJson: JSON.stringify({ error: rgResult.stderr.trim() || "rg replace failed" }) };
  }

  // rg --passthru adds a trailing newline; preserve original EOF
  const readTrailing = await runAsUser({
    file: process.execPath,
    args: ["-e", `const c=require("fs").readFileSync(${JSON.stringify(absPath)},"utf8");process.stdout.write(c.endsWith("\\n")?"1":"0")`],
    cwd,
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
  });
  let replaced = rgResult.stdout;
  if (readTrailing.stdout === "0" && replaced.endsWith("\n")) {
    replaced = replaced.slice(0, -1);
  }

  const writeResult = await runAsUser({
    file: process.execPath,
    args: ["-e", `require("fs").writeFileSync(${JSON.stringify(absPath)}, process.env.SR_CONTENT)`],
    cwd,
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
    env: { SR_CONTENT: replaced },
  });
  if (writeResult.exitCode !== 0) {
    return { resultJson: JSON.stringify({ error: writeResult.stderr.trim() || "failed to write file" }) };
  }

  return { resultJson: JSON.stringify({ replacements: totalMatches }) };
}
