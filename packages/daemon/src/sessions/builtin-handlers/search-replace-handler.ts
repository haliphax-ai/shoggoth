// ---------------------------------------------------------------------------
// builtin-search-replace — search (via rg) and replace text in files
// ---------------------------------------------------------------------------

import { realpathSync } from "node:fs";
import { relative, resolve, isAbsolute, sep } from "node:path";
import { runAsUser } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";

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
    searchPath = resolveAndGuard(ctx.workspacePath, String(args.path ?? "."));
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

  rgArgs.push("--", pattern, ".");

  const r = await runAsUser({
    file: "rg",
    args: rgArgs,
    cwd: searchPath,
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
  const file = args.file as string;
  const match = args.match as string;
  const replacement = args.replacement as string;
  if (!file || match == null || replacement == null) {
    return { resultJson: JSON.stringify({ error: "file, match, and replacement are required" }) };
  }

  let absPath: string;
  try {
    absPath = resolveAndGuard(ctx.workspacePath, file);
  } catch {
    return { resultJson: JSON.stringify({ error: "path escapes workspace" }) };
  }

  // Read file via runAsUser
  const readResult = await runAsUser({
    file: process.execPath,
    args: ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(absPath)}, "utf8"))`],
    cwd: realpathSync(ctx.workspacePath),
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
  });

  if (readResult.exitCode !== 0) {
    return { resultJson: JSON.stringify({ error: readResult.stderr.trim() || "failed to read file" }) };
  }

  const content = readResult.stdout;
  const count = typeof args.count === "number" ? args.count : 1;
  const maxReplacements = count === 0 ? Infinity : count;

  let result = "";
  let replacements = 0;
  let pos = 0;

  while (pos < content.length) {
    const idx = content.indexOf(match, pos);
    if (idx === -1 || replacements >= maxReplacements) {
      result += content.slice(pos);
      break;
    }
    result += content.slice(pos, idx) + replacement;
    replacements++;
    pos = idx + match.length;
  }

  if (replacements === 0) {
    return { resultJson: JSON.stringify({ error: "match not found in file" }) };
  }

  // Write file via runAsUser
  const writeResult = await runAsUser({
    file: process.execPath,
    args: ["-e", `require("fs").writeFileSync(${JSON.stringify(absPath)}, process.env.SR_CONTENT)`],
    cwd: realpathSync(ctx.workspacePath),
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
    env: { SR_CONTENT: result },
  });

  if (writeResult.exitCode !== 0) {
    return { resultJson: JSON.stringify({ error: writeResult.stderr.trim() || "failed to write file" }) };
  }

  return { resultJson: JSON.stringify({ replacements }) };
}
