import type { FetchLike } from "@shoggoth/models";

export function normalizeOpenAiEmbeddingBaseUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (t.endsWith("/v1")) return t;
  return `${t}/v1`;
}

export async function fetchOpenAiCompatibleTextEmbedding(input: {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly text: string;
  readonly fetchImpl?: FetchLike;
}): Promise<Float32Array> {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as FetchLike);
  const base = input.baseUrl.replace(/\/+$/, "");
  const url = `${base}/embeddings`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: input.model, input: input.text }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`embeddings HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("embeddings response is not JSON");
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("embeddings missing data[]");
  }
  const first = data[0];
  if (!first || typeof first !== "object") {
    throw new Error("embeddings missing data[0]");
  }
  const emb = (first as { embedding?: unknown }).embedding;
  if (!Array.isArray(emb) || emb.length === 0) {
    throw new Error("embeddings missing data[0].embedding");
  }
  return Float32Array.from(emb.map((x) => Number(x)));
}
