// ---------------------------------------------------------------------------
// builtin-ls — structured directory listing
// ---------------------------------------------------------------------------

import { realpathSync } from "node:fs";
import { relative, resolve, isAbsolute, sep } from "node:path";
import { runAsUser } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("ls", lsHandler);
}

// ---------------------------------------------------------------------------
// Sandbox helper — mirrors workspace-path.ts logic without requiring the
// target to exist (resolvePathForRead calls realpathSync which throws on
// missing paths; for ls we just need the logical check).
// ---------------------------------------------------------------------------

function resolveAndGuard(workspaceRoot: string, userPath: string): { rootReal: string; abs: string } {
  if (userPath.includes("\0")) throw new Error("NUL byte in path");
  const rootReal = realpathSync(workspaceRoot);
  const abs = isAbsolute(userPath) ? userPath : resolve(rootReal, userPath);
  const rel = relative(rootReal, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("path escapes workspace");
  }
  return { rootReal, abs };
}

// ---------------------------------------------------------------------------
// Subprocess script — runs as agent UID/GID so kernel DAC applies.
// Receives parameters via env vars, writes JSON to stdout.
// Uses the same string-array pattern as other builtin handler scripts.
// ---------------------------------------------------------------------------

function buildLsScript(): string {
  return [
    'const fs = require("fs");',
    'const path = require("path");',
    "const root = process.env.LS_ROOT;",
    "const workspaceRoot = process.env.LS_WORKSPACE_ROOT;",
    'const showAll = process.env.LS_ALL === "1";',
    'const recursive = process.env.LS_RECURSIVE === "1";',
    'const maxDepth = parseInt(process.env.LS_MAX_DEPTH || "5", 10);',
    'const globPattern = process.env.LS_GLOB || "";',
    'const includeStat = process.env.LS_STAT === "1";',
    'const limit = parseInt(process.env.LS_LIMIT || "1000", 10);',

    // Glob to regex conversion
    "let globRe = null;",
    "if (globPattern) {",
    "  const escaped = globPattern",
    "    .replace(/([.+^${}()|\\[\\]\\\\])/g, '\\\\$1')",
    "    .replace(/\\*\\*/g, '%%GLOBSTAR%%')",
    "    .replace(/\\*/g, '[^/]*')",
    "    .replace(/%%GLOBSTAR%%/g, '.*')",
    "    .replace(/\\?/g, '[^/]');",
    '  globRe = new RegExp("^" + escaped + "$");',
    "}",

    "const entries = [];",
    "let total = 0;",
    "let truncated = false;",

    "function entryType(dirent) {",
    '  if (dirent.isSymbolicLink()) return "symlink";',
    '  if (dirent.isDirectory()) return "directory";',
    '  if (dirent.isFile()) return "file";',
    '  return "other";',
    "}",

    "function walk(dir, depth) {",
    "  if (truncated) return;",
    "  let dirents;",
    "  try {",
    "    dirents = fs.readdirSync(dir, { withFileTypes: true });",
    "  } catch (e) {",
    "    return;",
    "  }",
    "  dirents.sort(function(a, b) { return a.name.localeCompare(b.name); });",
    "  for (var i = 0; i < dirents.length; i++) {",
    "    if (truncated) return;",
    "    var d = dirents[i];",
    '    if (!showAll && d.name.startsWith(".")) continue;',
    "    var fullPath = path.join(dir, d.name);",
    "    var relPath = path.relative(root, fullPath);",
    "    var type = entryType(d);",

    // Symlink escape detection
    "    var symlinkEscapes = false;",
    '    if (type === "symlink") {',
    "      try {",
    "        var realTarget = fs.realpathSync(fullPath);",
    "        var relToWs = path.relative(workspaceRoot, realTarget);",
    '        if (relToWs === ".." || relToWs.startsWith(".." + path.sep)) {',
    "          symlinkEscapes = true;",
    "        }",
    "      } catch (e2) {",
    "        symlinkEscapes = true;",
    "      }",
    "    }",

    // Glob filter
    "    if (globRe && !globRe.test(relPath)) {",
    '      if (recursive && (type === "directory" || (type === "symlink" && !symlinkEscapes)) && depth < maxDepth) {',
    "        walk(fullPath, depth + 1);",
    "      }",
    "      continue;",
    "    }",

    "    total++;",
    "    if (entries.length < limit) {",
    "      var entry = { path: relPath, type: type };",
    "      if (includeStat) {",
    "        try {",
    "          var st = fs.statSync(fullPath);",
    "          entry.size = st.size;",
    "          entry.mtime = st.mtime.toISOString();",
    "        } catch (e3) {}",
    "      }",
    "      entries.push(entry);",
    "    } else {",
    "      truncated = true;",
    "    }",

    // Recurse
    "    if (recursive && depth < maxDepth && !truncated) {",
    '      if (type === "directory" || (type === "symlink" && !symlinkEscapes)) {',
    "        walk(fullPath, depth + 1);",
    "      }",
    "    }",
    "  }",
    "}",

    "walk(root, 0);",
    "process.stdout.write(JSON.stringify({ entries: entries, truncated: truncated, total: total }));",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function lsHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const userPath = String(args.path ?? ".");
  const all = args.all === true;
  const recursive = args.recursive === true;
  const maxDepth = typeof args.maxDepth === "number" ? Math.max(1, Math.min(args.maxDepth, 20)) : 5;
  const glob = typeof args.glob === "string" ? args.glob : "";
  const stat = args.stat === true;
  const limit = typeof args.limit === "number" ? Math.max(1, Math.min(args.limit, 500)) : 500;

  // Resolve and sandbox-check the target directory
  const resolvedPath = resolveUserPath(ctx, userPath);
  const { rootReal, abs } = resolveAndGuard(ctx.workspacePath, resolvedPath);

  // Also verify the real path stays inside workspace (catches symlink escapes)
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch {
    return { resultJson: JSON.stringify({ error: `path does not exist: ${userPath}` }) };
  }
  const relCheck = relative(rootReal, realAbs);
  if (relCheck === ".." || relCheck.startsWith(`..${sep}`)) {
    return { resultJson: JSON.stringify({ error: "path escapes workspace" }) };
  }

  const cwd = rootReal;
  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", buildLsScript()],
    cwd,
    uid: ctx.creds.uid,
    gid: ctx.creds.gid,
    env: {
      LS_ROOT: realAbs,
      LS_WORKSPACE_ROOT: rootReal,
      LS_ALL: all ? "1" : "0",
      LS_RECURSIVE: recursive ? "1" : "0",
      LS_MAX_DEPTH: String(maxDepth),
      LS_GLOB: glob,
      LS_STAT: stat ? "1" : "0",
      LS_LIMIT: String(limit),
    },
  });

  if (r.exitCode !== 0) {
    return {
      resultJson: JSON.stringify({
        error: r.stderr.trim() || `ls failed with exit code ${r.exitCode}`,
      }),
    };
  }

  // Pass through the JSON from the subprocess
  return { resultJson: r.stdout };
}
