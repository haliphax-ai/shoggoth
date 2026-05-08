// ---------------------------------------------------------------------------
// builtin-media-generate — generate images, audio, video, or music via
// the media_generate control plane op, then optionally surface via show.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  BuiltinToolRegistry,
  BuiltinToolContext,
  BuiltinToolResult,
} from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import type { ChatContentPart } from "@shoggoth/models";
import { getBlockResolver, type ShowToolParams } from "../../presentation/show-blocks.js";
import { getLogger } from "../../logging.js";

const log = getLogger("media-generate-handler");

/** Map params.kind to a sensible default file extension. */
function extensionForKind(kind: string): string {
  switch (kind) {
    case "image":
      return ".png";
    case "video":
      return ".mp4";
    case "speech":
      return ".wav";
    case "music":
      return ".wav";
    default:
      return ".bin";
  }
}

export function register(registry: BuiltinToolRegistry): void {
  registry.register("media-generate", mediaGenerateHandler);
}

/**
 * Resolve the provider_id to use for media generation.
 * Priority: mediaGeneration.defaultProviderId → first gemini provider.
 */
function resolveProviderId(ctx: BuiltinToolContext): string | undefined {
  const explicit = ctx.config.mediaGeneration?.defaultProviderId;
  if (explicit) return explicit;
  const providers = ctx.config.models?.providers ?? [];
  const gemini = providers.find((p) => p.kind === "gemini");
  return gemini?.id;
}

async function mediaGenerateHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  const model = args.model as string | undefined;
  const prompt = args.prompt as string | undefined;
  const params = args.params as Record<string, unknown> | undefined;

  if (!model) return { resultJson: JSON.stringify({ error: "model is required" }) };
  if (!prompt) return { resultJson: JSON.stringify({ error: "prompt is required" }) };
  if (!params || typeof params !== "object" || !params.kind) {
    return { resultJson: JSON.stringify({ error: "params with kind is required" }) };
  }

  const providerId = resolveProviderId(ctx);
  if (!providerId) {
    return {
      resultJson: JSON.stringify({
        error:
          "No gemini provider configured. Add a gemini provider to models.providers or set mediaGeneration.defaultProviderId.",
      }),
    };
  }

  const invoker = ctx.getAgentIntegrationInvoker();
  if (!invoker) {
    return { resultJson: JSON.stringify({ error: "Integration invoker unavailable" }) };
  }

  const outputPath =
    typeof args.output_path === "string" && args.output_path
      ? resolveUserPath(ctx, args.output_path)
      : join(
          ctx.config.mediaGeneration?.outputDirectory ?? join(ctx.workspacePath, "tmp", "media"),
          `${randomUUID()}${extensionForKind(params.kind as string)}`,
        );
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;

  let result: Record<string, unknown>;
  try {
    result = (await invoker(ctx.sessionId, "media_generate", {
      model,
      prompt,
      provider_id: providerId,
      params,
      output_path: outputPath,
      ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
    })) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("media_generate_op_failed", { error: msg });
    return { resultJson: JSON.stringify({ error: msg }) };
  }

  if (!result || result.status === "error") {
    return { resultJson: JSON.stringify(result ?? { error: "unknown error" }) };
  }

  // For in_progress (async Veo), return immediately — agent can poll later.
  if (result.status === "in_progress") {
    return { resultJson: JSON.stringify(result) };
  }

  // Complete — optionally surface via show.
  const show = args.show !== false; // default true
  const contentParts: ChatContentPart[] = [];

  if (show && result.status === "complete" && result.path) {
    const mimeType = result.mime_type as string | undefined;
    // Only show images via builtin-show (audio/video are too large for inline content parts)
    if (mimeType && mimeType.startsWith("image/")) {
      try {
        const resolver = getBlockResolver("image");
        if (resolver) {
          const showParams: ShowToolParams = {
            type: "image",
            path: result.path as string,
          };
          const resolved = await resolver(showParams, {
            workspacePath: ctx.workspacePath,
            creds: ctx.creds,
          });
          if (resolved.kind === "contentPart") {
            contentParts.push(...resolved.parts);
          }
        }
      } catch (err) {
        log.warn("media_generate_show_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const response: BuiltinToolResult = {
    resultJson: JSON.stringify(result),
    ...(contentParts.length > 0 ? { contentParts } : {}),
  };
  return response;
}
