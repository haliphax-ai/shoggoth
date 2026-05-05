// ---------------------------------------------------------------------------
// read & write handlers
// ---------------------------------------------------------------------------

import { extname } from "node:path";
import { toolRead, toolReadBinary, toolWrite } from "@shoggoth/os-exec";
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

async function readHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string; contentParts?: ChatContentPart[] }> {
  const path = String(args.path ?? "");
  const lines = args.lines === true;
  const lineNumbers = args.lineNumbers === true;
  const resolvedPath = resolveUserPath(ctx, path);
  const ext = extname(path).toLowerCase();
  const imageMime = IMAGE_EXTENSION_TO_MIME[ext];

  if (imageMime) {
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

  const body = await toolRead(ctx.workspacePath, resolvedPath, ctx.creds);

  // Apply line processing if requested
  let content: string | string[];
  if (lines || lineNumbers) {
    // Split by newlines (handle \r\n, \n, and \r)
    const rawLines = body.split(/\r\n|\n|\r/);

    // Apply line numbers if requested
    if (lineNumbers) {
      content = rawLines.map((line, index) => `${index + 1}: ${line}`);
    } else {
      content = rawLines;
    }

    // Handle truncation for large files (>1000 lines)
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
    // Default behavior: return raw content as string
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
  const resolvedPath = resolveUserPath(ctx, path);
  await toolWrite(ctx.workspacePath, { path: resolvedPath, content, mkdirp: true }, ctx.creds);
  return { resultJson: JSON.stringify({ ok: true, path }) };
}
