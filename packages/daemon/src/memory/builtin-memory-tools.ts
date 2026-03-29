import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { FetchLike } from "@shoggoth/models";
import type { ShoggothMemoryConfig } from "@shoggoth/shared";
import {
  ingestMemoryRoots,
  searchMemoryWithOptionalEmbedding,
  upsertMemoryEmbedding,
  type MemoryHit,
} from "./memory-index";
import {
  resolveMemoryEmbeddingApiKeyEnv,
  resolveMemoryEmbeddingBaseUrl,
  resolveMemoryEmbeddingModelId,
} from "./memory-embeddings-resolve";
import { fetchOpenAiCompatibleTextEmbedding } from "./openai-embeddings";

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const MAX_BODY_CHARS = 1500;

/** Resolve configured memory roots: absolute paths as-is; relative paths under the session workspace. */
export function resolveMemoryScanRoots(
  workspacePath: string,
  paths: readonly string[],
): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(workspacePath, p);
    if (existsSync(abs)) out.push(abs);
  }
  return out;
}

function trimHit(hit: MemoryHit) {
  const body =
    hit.body.length > MAX_BODY_CHARS
      ? `${hit.body.slice(0, MAX_BODY_CHARS - 1)}…`
      : hit.body;
  return { id: hit.id, sourcePath: hit.sourcePath, title: hit.title, body };
}

function sourcePathUnderMemoryRoots(sourcePath: string, roots: string[]): boolean {
  for (const r of roots) {
    const root = r.endsWith("/") ? r.slice(0, -1) : r;
    if (sourcePath === root) return true;
    const prefix = `${root}/`;
    if (sourcePath.startsWith(prefix)) return true;
  }
  return false;
}

async function syncMemoryEmbeddingsAfterIngest(input: {
  readonly db: Database.Database;
  readonly absoluteRoots: string[];
  readonly memory: ShoggothMemoryConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchLike;
  readonly runtimeOpenaiBaseUrl?: string | undefined;
}): Promise<void> {
  const { db, absoluteRoots, memory, env, fetchImpl, runtimeOpenaiBaseUrl } = input;
  if (!memory.embeddings.enabled || absoluteRoots.length === 0) return;

  const modelId = resolveMemoryEmbeddingModelId(memory);
  const keyEnv = resolveMemoryEmbeddingApiKeyEnv(memory);
  const apiKey = env[keyEnv];
  const baseUrl = resolveMemoryEmbeddingBaseUrl(env, memory, runtimeOpenaiBaseUrl);

  const all = db
    .prepare(
      `SELECT id, source_path AS sourcePath, body, content_sha256 AS contentSha256 FROM memory_documents`,
    )
    .all() as { id: number; sourcePath: string; body: string; contentSha256: string }[];

  const docs = all.filter((d) => sourcePathUnderMemoryRoots(d.sourcePath, absoluteRoots));
  const selectEmbSha = db.prepare(
    `SELECT content_sha256 AS h FROM memory_embeddings WHERE document_id = @id AND model_id = @model`,
  );

  for (const d of docs) {
    const row = selectEmbSha.get({ id: d.id, model: modelId }) as { h: string | null } | undefined;
    const prev = row?.h ?? null;
    if (prev !== null && prev === d.contentSha256) continue;

    try {
      const vec = await fetchOpenAiCompatibleTextEmbedding({
        baseUrl,
        apiKey,
        model: modelId,
        text: d.body,
        fetchImpl,
      });
      upsertMemoryEmbedding(db, d.id, modelId, vec, d.contentSha256);
    } catch {
      /* omit embedding; FTS index remains usable */
    }
  }
}

export async function runMemoryBuiltin(input: {
  readonly originalName: string;
  readonly argsJson: string;
  readonly db: Database.Database;
  readonly workspacePath: string;
  readonly memory: ShoggothMemoryConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchLike;
  readonly runtimeOpenaiBaseUrl?: string | undefined;
}): Promise<{ resultJson: string }> {
  const {
    originalName,
    argsJson,
    db,
    workspacePath,
    memory,
    env,
    fetchImpl,
    runtimeOpenaiBaseUrl,
  } = input;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return { resultJson: JSON.stringify({ error: "invalid JSON args" }) };
  }

  if (originalName === "memory.ingest") {
    const roots = resolveMemoryScanRoots(workspacePath, memory.paths);
    const changed = roots.length === 0 ? 0 : ingestMemoryRoots(db, roots);
    await syncMemoryEmbeddingsAfterIngest({
      db,
      absoluteRoots: roots,
      memory,
      env,
      fetchImpl,
      runtimeOpenaiBaseUrl,
    });
    return {
      resultJson: JSON.stringify({
        changed,
        rootsScanned: roots.length,
        ...(roots.length === 0
          ? { message: "no configured memory paths exist on disk for this session" }
          : {}),
      }),
    };
  }

  if (originalName === "memory.search") {
    if (!memory.paths.length) {
      return {
        resultJson: JSON.stringify({
          hits: [],
          message: "memory.paths is empty in server config; operators must configure markdown roots",
        }),
      };
    }
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { resultJson: JSON.stringify({ error: "memory.search requires non-empty query" }) };
    }
    const rawLimit = args.limit;
    let limit = DEFAULT_LIMIT;
    if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)));
    }

    const modelId = resolveMemoryEmbeddingModelId(memory);
    let queryEmbedding: Float32Array | null = null;
    let embeddingsHealthy = false;
    if (memory.embeddings.enabled) {
      try {
        const keyEnv = resolveMemoryEmbeddingApiKeyEnv(memory);
        const apiKey = env[keyEnv];
        const baseUrl = resolveMemoryEmbeddingBaseUrl(env, memory, runtimeOpenaiBaseUrl);
        queryEmbedding = await fetchOpenAiCompatibleTextEmbedding({
          baseUrl,
          apiKey,
          model: modelId,
          text: query,
          fetchImpl,
        });
        embeddingsHealthy = true;
      } catch {
        queryEmbedding = null;
        embeddingsHealthy = false;
      }
    }

    const hits = searchMemoryWithOptionalEmbedding(db, {
      textQuery: query,
      limit,
      embeddingsEnabled: memory.embeddings.enabled,
      queryEmbedding,
      embeddingModelId: modelId,
      embeddingsHealthy,
    });
    return {
      resultJson: JSON.stringify({
        query,
        hits: hits.map(trimHit),
      }),
    };
  }

  return { resultJson: JSON.stringify({ error: `unknown memory builtin: ${originalName}` }) };
}
