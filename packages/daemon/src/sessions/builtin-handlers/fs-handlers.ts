// ---------------------------------------------------------------------------
// read & write handlers
// ---------------------------------------------------------------------------

import { extname, isAbsolute, relative } from "node:path";
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
  // If relative() produces a path starting with "..", the path is outside
  // the workspace — return the absolute path and let os-exec reject it.
  if (rel.startsWith("..")) return absolutePath;
  return rel;
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
    return { resultJson: JSON.stringify({ path }), contentParts };
  }

  // Check if any extended params are used (multi-path, line range, stat)
  const hasExtended =
    (paths && paths.length > 0) ||
    fromLine !== undefined ||
    toLine !== undefined ||
    offset !== undefined ||
    limit !== undefined ||
    stat === true;

  if (hasExtended) {
    // Resolve paths against workingDirectory, then convert to workspace-relative
    // because toolReadExtended internally joins paths with the workspace root.
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

    // Handle stat results
    if (result.kind === "stat-single") {
      return { resultJson: JSON.stringify({ path, stat: result.stat }) };
    }
    if (result.kind === "stat-multi") {
      return { resultJson: JSON.stringify({ stats: result.stats }) };
    }

    // Handle multi-file results
    if (result.kind === "multi") {
      const output: Record<string, unknown> = { files: result.files };
      if (result.notices) output.notices = result.notices;
      return { resultJson: JSON.stringify(output) };
    }

    // Single file result — apply lines/lineNumbers formatting
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

    return {
      resultJson: JSON.stringify({ path, content }),
    };
  }

  // Simple single-file read (no extended params)
  const body = await toolRead(ctx.workspacePath, resolvedPath, ctx.creds);

  // Apply line processing if requested
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

  return {
    resultJson: JSON.stringify({ path, content }),
  };
}

async function writeHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  // AGENTS.md discovery gate
  const cwd = ctx.workingDirectory ?? ctx.workspacePath;
  const gate = checkAgentsMdGate(ctx.db, ctx.sessionId, cwd, ctx.workspacePath);
  if (gate) return { resultJson: JSON.stringify(gate) };

  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  const append = args.append === true;
  const resolvedPath = resolveUserPath(ctx, path);
  await toolWrite(
    ctx.workspacePath,
    { path: resolvedPath, content, append, mkdirp: true },
    ctx.creds,
  );
  return { resultJson: JSON.stringify({ ok: true, path }) };
}
