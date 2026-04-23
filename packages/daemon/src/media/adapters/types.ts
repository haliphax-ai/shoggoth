export interface ImageGenerateParams {
  kind: "image";
  aspectRatio?: string;
  numberOfImages?: number;
  input_image?: string;
}

export interface VideoGenerateParams {
  kind: "video";
  aspectRatio?: string;
  durationSeconds?: number;
  input_image?: string;
}

export interface SpeechGenerateParams {
  kind: "speech";
  voice?: string;
}

export interface MusicGenerateParams {
  kind: "music";
  durationSeconds?: number;
}

export type MediaGenerateParams =
  | ImageGenerateParams
  | VideoGenerateParams
  | SpeechGenerateParams
  | MusicGenerateParams;

export interface MediaGeneratePayload {
  model: string;
  prompt: string;
  provider_id: string;
  params: MediaGenerateParams;
  output_path?: string;
  timeout_ms?: number;
}

export interface MediaAdapterRequest {
  model: string;
  prompt: string;
  apiKey: string;
  baseUrl: string;
  outputPath: string;
  params: MediaGenerateParams;
}

export type MediaAdapterResult =
  | { status: "complete"; path: string; mime_type: string }
  | { status: "in_progress"; operation_id: string }
  | { status: "error"; error: string };
