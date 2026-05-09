import type { MediaAdapterRequest, MediaAdapterResult } from "./types";

/**
 * OpenAI Video Async Adapter
 *
 * Handles async video generation via OpenAI-compatible API.
 *
 * Submit: POST {baseUrl}/chat/completions with { model, messages: [{role:'user', content: prompt}] }
 * Extract generation_id from body `id` or header `X-Generation-Id`
 * Poll: GET {baseUrl}/generation?id={generation_id} with auth
 * Poll response: { status: 'complete', video_url } or { status: 'pending' }
 *
 * Uses adapterDefaults.pollIntervalMs (default 5000) and adapterDefaults.timeoutMs (default 300000)
 * On complete: download video_url, write to outputPath
 * On timeout: return in_progress
 */
export async function openaiVideoAsyncAdapter(
  req: MediaAdapterRequest & { adapterDefaults?: { pollIntervalMs?: number; timeoutMs?: number } },
): Promise<MediaAdapterResult> {
  throw new Error("OpenAI Video Async Adapter not yet implemented");
}