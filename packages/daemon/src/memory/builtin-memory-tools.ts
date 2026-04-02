import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { FetchLike } from "@shoggoth/models";
import type { ShoggothMemoryConfig } from "@shoggoth/shared";
import {
  ingestMemoryRoots,
  searchMemoryWithOptionalEmbedding,
  upsertMemoryEmbedding,
  extractSnippet,
  type MemoryHit,
  type MemorySearchFilters,
  type IngestOptions,
} from "./memory-index";
import {
  resolveMemoryEmbeddingApiKey,
  resolveMemoryEmbeddingBaseUrl,
  resolveMemoryEmbeddingModelId,
} from "./memory-embeddings-resolve";
import { fetchOpenAiCompatibleTextEmbedding } from "./openai-embeddings";

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const MAX_BODY_CHARS = 1500;
const DEFAULT_SNIPPET_CHARS = 200;
const MAX_SNIPPET_CHARS = 1000;
/** Maximum number of file entries included in the ingest report response. */
const MAX_REPORT_FILES = 200;

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
  const apiKey = resolveMemoryEmbeddingApiKey(memory, env);
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

  if (originalName === "memory-ingest") {
    const roots = resolveMemoryScanRoots(workspacePath, memory.paths);

    // --- New parameters ---
    const report = args.report === true;

    // Selective ingest: paths (include globs) and exclude globs.
    const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]) : [];
    const includePaths = rawPaths
      .map((p) => String(p).trim())
      .filter((p) => p.length > 0);

    const rawExclude = Array.isArray(args.exclude) ? (args.exclude as unknown[]) : [];
    const excludePaths = rawExclude
      .map((p) => String(p).trim())
      .filter((p) => p.length > 0);

    const ingestOpts: IngestOptions | undefined =
      includePaths.length > 0 || excludePaths.length > 0
        ? { paths: includePaths, exclude: excludePaths }
        : undefined;

    const result = roots.length === 0
      ? { changed: 0, files: [] }
      : ingestMemoryRoots(db, roots, ingestOpts);

    await syncMemoryEmbeddingsAfterIngest({
      db,
      absoluteRoots: roots,
      memory,
      env,
      fetchImpl,
      runtimeOpenaiBaseUrl,
    });

    // Build response — backward compatible when report is false.
    const response: Record<string, unknown> = {
      changed: result.changed,
      rootsScanned: roots.length,
    };

    if (roots.length === 0) {
      response.message = "no configured memory paths exist on disk for this session";
    }

    if (report) {
      const truncated = result.files.length > MAX_REPORT_FILES;
      response.files = result.files.slice(0, MAX_REPORT_FILES);
      if (truncated) {
        response.truncated = true;
      }
    }

    return { resultJson: JSON.stringify(response) };
  }

  if (originalName === "memory-search") {
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
      return { resultJson: JSON.stringify({ error: "memory-search requires non-empty query" }) };
    }
    const rawLimit = args.limit;
    let limit = DEFAULT_LIMIT;
    if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)));
    }

    // --- New parameters ---
    const includeScores = args.include_scores === true;
    const minScore =
      typeof args.min_score === "number" && Number.isFinite(args.min_score)
        ? Math.max(0, Math.min(1, args.min_score))
        : 0;

    // Path prefix filter.
    const pathPrefix =
      typeof args.path_prefix === "string" && args.path_prefix.trim()
        ? args.path_prefix.trim()
        : null;

    // Date range filters (ISO 8601 → ms since epoch).
    let afterMs: number | null = null;
    let beforeMs: number | null = null;
    if (typeof args.after === "string" && args.after.trim()) {
      const parsed = Date.parse(args.after.trim());
      if (Number.isNaN(parsed)) {
        return { resultJson: JSON.stringify({ error: "invalid ISO 8601 date for 'after'" }) };
      }
      afterMs = parsed;
    }
    if (typeof args.before === "string" && args.before.trim()) {
      const parsed = Date.parse(args.before.trim());
      if (Number.isNaN(parsed)) {
        return { resultJson: JSON.stringify({ error: "invalid ISO 8601 date for 'before'" }) };
      }
      beforeMs = parsed;
    }
    if (afterMs != null && beforeMs != null && afterMs >= beforeMs) {
      return {
        resultJson: JSON.stringify({ error: "'after' must be earlier than 'before'" }),
      };
    }

    // Snippet options.
    const snippetMode = args.snippet === true;
    let snippetChars = DEFAULT_SNIPPET_CHARS;
    if (typeof args.snippet_chars === "number" && Number.isFinite(args.snippet_chars)) {
      snippetChars = Math.min(MAX_SNIPPET_CHARS, Math.max(20, Math.floor(args.snippet_chars)));
    }
    const highlightTag =
      typeof args.highlight_tag === "string" ? args.highlight_tag : "**";
    // When snippet mode is on, body is omitted unless include_body is explicitly true.
    const includeBody = snippetMode ? args.include_body === true : true;

    const filters: MemorySearchFilters = {
      pathPrefix,
      afterMs,
      beforeMs,
    };

    const modelId = resolveMemoryEmbeddingModelId(memory);
    let queryEmbedding: Float32Array | null = null;
    let embeddingsHealthy = false;
    if (memory.embeddings.enabled) {
      try {
        const apiKey = resolveMemoryEmbeddingApiKey(memory, env);
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
      includeScores,
      minScore,
      filters,
    });

    const formattedHits = hits.map((hit) => {
      const out: Record<string, unknown> = {
        id: hit.id,
        sourcePath: hit.sourcePath,
        title: hit.title,
      };

      if (snippetMode) {
        out.snippet = extractSnippet(hit.body, query, {
          maxChars: snippetChars,
          highlightTag,
        });
      }

      if (includeBody) {
        out.body =
          hit.body.length > MAX_BODY_CHARS
            ? `${hit.body.slice(0, MAX_BODY_CHARS - 1)}…`
            : hit.body;
      }

      if (includeScores) {
        out.score = hit.score ?? null;
      }

      return out;
    });

    return {
      resultJson: JSON.stringify({
        query,
        hits: formattedHits,
      }),
    };
  }

  return { resultJson: JSON.stringify({ error: `unknown memory builtin: ${originalName}` }) };
}
