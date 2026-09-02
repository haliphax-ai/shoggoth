// ---------------------------------------------------------------------------
// read & write handlers
// ---------------------------------------------------------------------------

import { extname, isAbsolute, join as pathJoin, relative } from "node:path";
import {
  toolRead,
  toolReadBinary,
  toolReadExtended,
  toolWrite,
  type ReadExtendedOptions,
} from "@shoggoth/os-exec";
import { IMAGE_EXTENSION_TO_MIME, MAX_IMAGE_BLOCK_BYTES } from "@shoggoth/shared";
import type { ChatContentPart } from "@shoggoth/models";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { truncateToolOutput } from "./truncate-output";
import { checkAgentsMdGate } from "../agents-md-gate";
import { checkReReadRequired, clearReReadRequired } from "../re-read-required";
import { getSessionContextSegmentId } from "../session-store";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("read", readHandler);
  registry.register("write", writeHandler);
}

/**
 * Convert a resolved absolute path back to workspace-relative.
 * toolReadExtended expects workspace-relative paths because it internally
 * joins them with the workspace root. If the path is already relative or
 * escapes the workspace (e.g. /app docs), return it as-is for the security
 * layer in os-exec to handle.
 */
function toWorkspaceRelative(ctx: BuiltinToolContext, absolutePath: string): string {
  if (!isAbsolute(absolutePath)) return absolutePath;
  const rel = relative(ctx.workspacePath, absolutePath);
  if (rel.startsWith("..")) return absolutePath;
  return rel;
}

/**
 * Whether `ctx.db` looks like a real better-sqlite3 handle. Tests that
 * exercise unrelated code paths may pass a stub `db: {} as any`; in that
 * case the re-read gate is a no-op.
 */
function hasRealDb(ctx: BuiltinToolContext): boolean {
  return typeof (ctx.db as { prepare?: unknown })?.prepare === "function";
}

/**
 * Clear the re-read flag for `absPath` in the current segment. Used by the
 * read handler after a successful content read so that subsequent edits
 * are not gated as stale. Best-effort: never throws.
 */
function clearReReadFlag(ctx: BuiltinToolContext, absPath: string): void {
  if (!hasRealDb(ctx)) return;
  try {
    const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
    clearReReadRequired(ctx.db, ctx.sessionId, segmentId, absPath);
  } catch {
    // ignore
  }
}

/**
 * Clear the re-read flag for every file in a multi-file read result.
 * `result.files` keys are workspace-relative; convert to absolute before
 * looking up the gate. Best-effort: never throws.
 */
function clearMultiReReadFlags(ctx: BuiltinToolContext, files: Record<string, string>): void {
  if (!hasRealDb(ctx)) return;
  try {
    const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
    for (const relPath of Object.keys(files)) {
      const abs = pathJoin(ctx.workspacePath, relPath);
      clearReReadRequired(ctx.db, ctx.sessionId, segmentId, abs);
    }
  } catch {
    // ignore
  }
}

/**
 * Look up the re-read gate for `absPath` in the current segment. Returns
 * the gate result payload if blocked, null otherwise. Best-effort: returns
 * null on any internal error so a stale db state cannot block writes.
 */
function reReadGateFor(ctx: BuiltinToolContext, absPath: string): unknown | null {
  if (!hasRealDb(ctx)) return null;
  try {
    const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
    return checkReReadRequired(ctx.db, ctx.sessionId, segmentId, absPath);
  } catch {
    return null;
  }
}

async function readHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string; contentParts?: ChatContentPart[] }> {
  const path = String(args.path ?? "");
  const paths = args.paths as string[] | undefined;
  const lines = args.lines === true;
  const lineNumbers = args.lineNumbers === true;
  const fromLine = typeof args.fromLine === "number" ? args.fromLine : undefined;
  const toLine = typeof args.toLine === "number" ? args.toLine : undefined;
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  const stat = args.stat === true;
  const maxFiles = typeof args.maxFiles === "number" ? args.maxFiles : undefined;

  const resolvedPath = resolveUserPath(ctx, path);
  const ext = extname(path).toLowerCase();
  const imageMime = IMAGE_EXTENSION_TO_MIME[ext];

  // Image handling (single path only)
  if (path && imageMime) {
    if (!ctx.imageBlockCodec) {
      return {
        resultJson: JSON.stringify({
          error: "Image content not supported by the active model provider.",
          path,
        }),
      };
    }
    const buf = await toolReadBinary(ctx.workspacePath, resolvedPath, ctx.creds);
    if (buf.length > MAX_IMAGE_BLOCK_BYTES) {
      const sizeMB = (buf.length / (1024 * 1024)).toFixed(1);
      return {
        resultJson: JSON.stringify({
          error: `Image too large to include in context (${sizeMB} MB, limit ${MAX_IMAGE_BLOCK_BYTES / (1024 * 1024)} MB). Consider resizing.`,
          path,
        }),
      };
    }
    const base64 = buf.toString("base64");
    const contentParts: ChatContentPart[] = [
      { type: "image", mediaType: imageMime, base64 },
      { type: "text", text: `Image file: ${path}` },
    ];
    clearReReadFlag(ctx, resolvedPath);
    return { resultJson: JSON.stringify({ path }), contentParts };
  }

  const hasExtended =
    (paths && paths.length > 0) ||
    fromLine !== undefined ||
    toLine !== undefined ||
    offset !== undefined ||
    limit !== undefined ||
    stat === true;

  if (hasExtended) {
    const resolvedPaths = paths?.map((p) => toWorkspaceRelative(ctx, resolveUserPath(ctx, p)));

    const opts: ReadExtendedOptions = {
      path: paths ? undefined : toWorkspaceRelative(ctx, resolvedPath),
      paths: resolvedPaths,
      fromLine,
      toLine,
      offset,
      limit,
      stat,
      maxFiles,
    };

    const result = await toolReadExtended(ctx.workspacePath, opts, ctx.creds);

    if (result.kind === "stat-single") {
      return { resultJson: JSON.stringify({ path, stat: result.stat }) };
    }
    if (result.kind === "stat-multi") {
      return { resultJson: JSON.stringify({ stats: result.stats }) };
    }

    if (result.kind === "multi") {
      const output: Record<string, unknown> = { files: result.files };
      if (result.notices) output.notices = result.notices;
      clearMultiReReadFlags(ctx, result.files);
      return { resultJson: JSON.stringify(output) };
    }

    const body = result.content;
    let content: string | string[];
    if (lines || lineNumbers) {
      const rawLines = body.split(/\r\n|\n|\r/);
      if (lineNumbers) {
        content = rawLines.map((line, index) => `${index + 1}: ${line}`);
      } else {
        content = rawLines;
      }
      if (lines && rawLines.length > 1000) {
        const truncatedContent = rawLines.slice(0, 1000);
        if (lineNumbers) {
          content = truncatedContent.map((line, index) => `${index + 1}: ${line}`);
        } else {
          content = truncatedContent;
        }
        content.push(`[... truncated — file has ${rawLines.length} lines, showing first 1000 ...]`);
      }
    } else {
      content = truncateToolOutput(body);
    }

    clearReReadFlag(ctx, resolvedPath);
    return { resultJson: JSON.stringify({ path, content }) };
  }

  const body = await toolRead(ctx.workspacePath, resolvedPath, ctx.creds);

  let content: string | string[];
  if (lines || lineNumbers) {
    const rawLines = body.split(/\r\n|\n|\r/);
    if (lineNumbers) {
      content = rawLines.map((line, index) => `${index + 1}: ${line}`);
    } else {
      content = rawLines;
    }
    if (lines && rawLines.length > 1000) {
      const truncatedContent = rawLines.slice(0, 1000);
      if (lineNumbers) {
        content = truncatedContent.map((line, index) => `${index + 1}: ${line}`);
      } else {
        content = truncatedContent;
      }
      content.push(`[... truncated — file has ${rawLines.length} lines, showing first 1000 ...]`);
    }
  } else {
    content = truncateToolOutput(body);
  }

  clearReReadFlag(ctx, resolvedPath);
  return { resultJson: JSON.stringify({ path, content }) };
}

async function writeHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const cwd = ctx.workingDirectory ?? ctx.workspacePath;
  const gate = checkAgentsMdGate(ctx.db, ctx.sessionId, cwd, ctx.workspacePath);
  if (gate) return { resultJson: JSON.stringify(gate) };

  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  const append = args.append === true;
  const resolvedPath = resolveUserPath(ctx, path);

  // Re-read gate (consumer): refuse to overwrite/append a file the agent
  // hasn't re-read since the last line-shifting replace.
  const reReadGate = reReadGateFor(ctx, resolvedPath);
  if (reReadGate) return { resultJson: JSON.stringify(reReadGate) };

  await toolWrite(
    ctx.workspacePath,
    { path: resolvedPath, content, append, mkdirp: true },
    ctx.creds,
  );
  return { resultJson: JSON.stringify({ ok: true, path }) };
}
