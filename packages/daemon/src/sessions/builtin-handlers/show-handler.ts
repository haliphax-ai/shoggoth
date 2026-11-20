// ---------------------------------------------------------------------------
// show handler — surfaces content blocks (images) to the user
// ---------------------------------------------------------------------------

import type { ChatContentPart } from "@shoggoth/models";
import type {
  BuiltinToolRegistry,
  BuiltinToolContext,
  BuiltinToolResult,
} from "../builtin-tool-registry.js";
import { resolveUserPath } from "../builtin-tool-registry.js";
import { getBlockResolver, type ShowToolParams } from "../../presentation/show-blocks.js";
import { getLogger } from "../../logging.js";

const log = getLogger("show-handler");

const MAX_SHOW_BYTES = 10 * 1024 * 1024; // 10 MB

export function register(registry: BuiltinToolRegistry): void {
  registry.register("show", showHandler);
}

async function showHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  const type = args.type as string | undefined;
  if (!type) {
    return { resultJson: JSON.stringify({ error: "type is required" }) };
  }

  const resolver = getBlockResolver(type);
  if (!resolver) {
    return {
      resultJson: JSON.stringify({ error: `unsupported block type: ${type}` }),
    };
  }

  // Support single params object or array of params for multi-block calls
  const inputs: ShowToolParams[] = Array.isArray(args.items)
    ? (args.items as ShowToolParams[]).map((item) => ({
        ...item,
        type: type as "image",
      }))
    : [args as unknown as ShowToolParams];

  const allParts: ChatContentPart[] = [];
  let totalBytes = 0;
  let count = 0;

  for (const input of inputs) {
    try {
      // For path-based inputs, store a lightweight reference instead of
      // the full base64 payload so the transcript stays small.  The
      // extraction step (extractShowBlocks) will read the file at
      // delivery time.
      if (input.path) {
        // Resolve path against workingDirectory, then make workspace-relative
        // so toolReadBinary (which joins with workspacePath) finds the file.
        const resolvedPath = resolveUserPath(ctx, input.path);
        const wsRelativePath = resolvedPath.startsWith(ctx.workspacePath)
          ? resolvedPath.slice(ctx.workspacePath.length).replace(/^\//, "")
          : resolvedPath;
        const resolvedInput: ShowToolParams = { ...input, path: wsRelativePath };

        // Still resolve to validate the file exists and is a supported image
        const resolved = await resolver(resolvedInput, {
          workspacePath: ctx.workspacePath,
          creds: ctx.creds,
        });
        if (resolved.kind === "contentPart") {
          for (const part of resolved.parts) {
            if (part.type === "image" && part.base64) {
              totalBytes += Math.floor(part.base64.length * 0.75);
            }
          }
          // Store workspace-relative path reference + display label instead of base64
          allParts.push(
            { type: "text", text: `[show-file: ${wsRelativePath}]` },
            {
              type: "text",
              text: `[show: ${input.filename ?? input.path.split("/").pop() ?? "image"}]`,
            },
          );
          count++;
        }
      } else {
        const resolved = await resolver(input, {
          workspacePath: ctx.workspacePath,
          creds: ctx.creds,
        });
        if (resolved.kind === "contentPart") {
          allParts.push(...resolved.parts);
          for (const part of resolved.parts) {
            if (part.type === "image" && part.base64) {
              totalBytes += Math.floor(part.base64.length * 0.75);
            }
          }
          count++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("show_handler.resolve_failed", { type, error: msg });
      return {
        resultJson: JSON.stringify({
          error: msg,
          type,
          path: input.path,
          url: input.url,
        }),
      };
    }
  }

  if (totalBytes > MAX_SHOW_BYTES) {
    const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
    return {
      resultJson: JSON.stringify({
        error: `Show input too large (${sizeMB} MB, limit 10 MB).`,
        type,
      }),
    };
  }

  return {
    resultJson: JSON.stringify({ ok: true, type, count, totalBytes }),
    contentParts: allParts,
  };
}
