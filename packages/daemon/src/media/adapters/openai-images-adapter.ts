import type { ResolvedMediaProvider } from '../resolve-model.js';
import type { MediaGenerateParams, MediaAdapterResult } from './types.js';

export interface OpenAIImagesAdapterRequest {
  model: string;
  prompt: string;
  provider: ResolvedMediaProvider;
  outputPath: string;
  params: MediaGenerateParams;
}

export async function openAIImagesAdapter(
  _req: OpenAIImagesAdapterRequest,
): Promise<MediaAdapterResult> {
  throw new Error('not implemented');
}