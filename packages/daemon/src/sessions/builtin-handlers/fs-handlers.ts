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

export function register(registry: BuiltinToolRegistry): void {
  registry.register("read", readHandler);
  registry.register("write", writeHandler);
}

async function readHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string; contentParts?: ChatContentPart[] }> {
  const path = String(args.path ?? "");
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
  return { resultJson: JSON.stringify({ path, content: truncateToolOutput(body) }) };
}

async function writeHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  const resolvedPath = resolveUserPath(ctx, path);
  await toolWrite(ctx.workspacePath, { path: resolvedPath, content, mkdirp: true }, ctx.creds);
  return { resultJson: JSON.stringify({ ok: true, path }) };
}
