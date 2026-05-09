import type { MediaAdapterRequest, MediaAdapterResult } from "./types";

interface ResolvedMediaProvider {
  id: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
}

interface ImageRequest extends Omit<MediaAdapterRequest, "apiKey" | "baseUrl"> {
  provider: ResolvedMediaProvider;
}

export async function openAIChatImageAdapter(
  req: ImageRequest,
): Promise<MediaAdapterResult> {
  throw new Error("Not implemented");
}