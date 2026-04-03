// ---------------------------------------------------------------------------
// show handler — surfaces content blocks (images) to the user
// ---------------------------------------------------------------------------

import type { ChatContentPart } from "@shoggoth/models";
import type { BuiltinToolRegistry, BuiltinToolContext, BuiltinToolResult } from "../builtin-tool-registry.js";
import { getBlockResolver, type ShowToolParams } from "../../presentation/show-blocks.js";
import { getLogger } from "../../logging.js";

const log = getLogger("show-handler");

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
    return { resultJson: JSON.stringify({ error: `unsupported block type: ${type}` }) };
  }

  // Support single params object or array of params for multi-block calls
  const inputs: ShowToolParams[] = Array.isArray(args.items)
    ? (args.items as ShowToolParams[]).map((item) => ({ ...item, type: type as "image" }))
    : [args as unknown as ShowToolParams];

  const allParts: ChatContentPart[] = [];
  let totalBytes = 0;
  let count = 0;

  for (const input of inputs) {
    try {
      const resolved = await resolver(input, {
        workspacePath: ctx.workspacePath,
        creds: ctx.creds,
      });

      if (resolved.kind === "contentPart") {
        allParts.push(...resolved.parts);
        // Count bytes from base64 image parts
        for (const part of resolved.parts) {
          if (part.type === "image" && part.base64) {
            totalBytes += Math.floor(part.base64.length * 0.75);
          }
        }
        count++;
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

  return {
    resultJson: JSON.stringify({ ok: true, type, count, totalBytes }),
    contentParts: allParts,
  };
}
