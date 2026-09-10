// ---------------------------------------------------------------------------
// builtin-media-generate — generate images, audio, video, or music via
// the media_generate control plane op, saving the result to disk.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import type {
  BuiltinToolRegistry,
  BuiltinToolContext,
  BuiltinToolResult,
} from "../builtin-tool-registry";
import { resolveUserPath } from "../builtin-tool-registry";
import { getLogger } from "../../logging.js";

const log = getLogger("media-generate-handler");

/**
 * Read the input image for editing from a workspace-relative path, base64-encode it,
 * and return the base64 string. The adapters receive this base64 data directly.
 *
 * Returns undefined when no input path was supplied.
 */
async function resolveInputImageBase64(
  inputPath: unknown,
  ctx: BuiltinToolContext,
): Promise<string | undefined> {
  if (typeof inputPath !== "string" || inputPath.length === 0) return undefined;
  const abs = resolveUserPath(ctx, inputPath);
  const bytes = await readFile(abs);
  return bytes.toString("base64");
}

export function register(registry: BuiltinToolRegistry): void {
  registry.register("media-generate", mediaGenerateHandler);
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

  // Check that media generation is configured
  const hasMediaConfig = (ctx.config.mediaGeneration?.providers ?? []).some(
    (p: { models?: unknown[] }) => (p.models?.length ?? 0) > 0,
  );
  if (!hasMediaConfig) {
    return {
      resultJson: JSON.stringify({
        error:
          "Media generation not configured. Add providers and models to mediaGeneration config.",
      }),
    };
  }

  const invoker = ctx.getAgentIntegrationInvoker();
  if (!invoker) {
    return { resultJson: JSON.stringify({ error: "Integration invoker unavailable" }) };
  }

  if (typeof args.output_path !== "string" || !args.output_path) {
    return { resultJson: JSON.stringify({ error: "output_path is required" }) };
  }
  const outputPath = resolveUserPath(ctx, args.output_path);
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;

  let result: Record<string, unknown>;
  // Resolve input_path (if provided) into base64 and attach as input_image so
  // the control op / adapters receive raw base64 rather than a file path.
  if (params.input_path != null) {
    const inputImageBase64 = await resolveInputImageBase64(params.input_path, ctx);
    if (inputImageBase64 != null) {
      (params as Record<string, unknown>).input_image = inputImageBase64;
    }
    delete (params as Record<string, unknown>).input_path;
  }
  try {
    result = (await invoker(ctx.sessionId, "media_generate", {
      model,
      prompt,
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

  // Complete — file is on disk at outputPath.
  const response: BuiltinToolResult = {
    resultJson: JSON.stringify(result),
  };
  return response;
}
