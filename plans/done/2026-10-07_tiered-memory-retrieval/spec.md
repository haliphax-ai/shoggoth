# Specification

## Interfaces

### Config schema (`packages/shared/src/schema/memory.ts`)

```ts
export const shoggothMemoryVectorConfigSchema = z
  .object({
    /** Use sqlite-vector SQL scans instead of the JS cosine path. */
    enabled: z.boolean().default(false),
  })
  .strict();

export const shoggothMemoryHybridConfigSchema = z
  .object({
    /** Fuse BM25 + vector recall with RRF instead of either/or. Requires embeddings. */
    enabled: z.boolean().default(false),
    /** Candidate pool pulled from the BM25 leg. */
    bm25Candidates: z.number().int().min(1).max(500).default(50),
    /** Candidate pool pulled from the vector leg. */
    vectorCandidates: z.number().int().min(1).max(500).default(50),
    /** RRF smoothing constant. */
    rrfK: z.number().int().min(1).max(200).default(60),
  })
  .strict();

export const shoggothMemoryRerankConfigSchema = z
  .object({
    /** Run stage-2 reranking over the fused pool. Requires #273 rerank config. */
    enabled: z.boolean().default(false),
    /** How many fused candidates to hand the reranker. */
    candidates: z.number().int().min(1).max(100).default(20),
    /** Stage-2 budget; exceeding it falls back to the fused order. */
    timeoutMs: z.number().int().min(100).max(30_000).default(3_000),
  })
  .strict();

export const shoggothMemoryConfigSchema = z
  .object({
    paths: z.array(workspaceRelativePathSchema),
    embeddings: shoggothMemoryEmbeddingsConfigSchema,
    vector: shoggothMemoryVectorConfigSchema.optional(),
    hybrid: shoggothMemoryHybridConfigSchema.optional(),
    rerank: shoggothMemoryRerankConfigSchema.optional(),
  })
  .strict();
```

`DEFAULT_MEMORY_CONFIG` gains `vector: { enabled: false }`, `hybrid: { enabled: false, bm25Candidates: 50, vectorCandidates: 50, rrfK: 60 }`, `rerank: { enabled: false, candidates: 20, timeoutMs: 3000 }`. The per-agent memory fragment in `packages/shared/src/schema/config.ts` mirrors `embeddings`' pattern: `vector/hybrid/rerank: <schema>.partial().optional()`.

All three keys are optional and off by default: a config parsed before this plan exists parses identically after it.

### Vector leg (`packages/daemon/src/memory/memory-vector.ts`)

```ts
/** Load sqlite-vector into this connection. Returns false when unavailable (missing binary, load error). */
export function loadVectorExtension(db: Database.Database): boolean;

/**
 * Idempotent per connection: loadVectorExtension + vector_init for the target table/column.
 * Reads `dimensions` from a stored row; no-op (returns false) when no rows exist or the
 * extension is unavailable. Safe to call before every query.
 */
export function ensureVectorReady(
  db: Database.Database,
  target: "documents" | "chunks",
  modelId: string,
): boolean;

/** True when the extension loaded and vector_init succeeded for both targets in play. */
export function vectorSearchAvailable(db: Database.Database): boolean;

export interface VectorSearchOptions {
  readonly query: Float32Array;
  readonly modelId: string;
  readonly limit: number;
  readonly filters?: MemorySearchFilters;
}

export interface VectorDocHit {
  readonly documentId: number;
  /** 1 - COSINE distance, clamped to [0, 1]. */
  readonly similarity: number;
}

/** Top-N documents by vector similarity (chunks aggregated via MIN(distance)). */
export function searchMemoryVectorDocs(
  db: Database.Database,
  opts: VectorSearchOptions,
): VectorDocHit[];
```

Streaming scan (no `k`) so filters compose and results are exact at this corpus size:

```sql
-- documents target (pre-Phase 3)
SELECT e.document_id AS documentId, MIN(1.0 - v.distance) AS similarity
FROM vector_full_scan('memory_embeddings', 'embedding', @qblob) AS v
JOIN memory_embeddings e ON e.rowid = v.rowid
WHERE e.model_id = @model
  /* + optional (d.source_path = @pathExact OR d.source_path LIKE @pathLike) via JOIN memory_documents d */
GROUP BY e.document_id
ORDER BY similarity DESC
LIMIT @lim;

-- chunks target (post-Phase 3): same shape over chunk_embeddings JOIN memory_chunks
```

### Fusion (`packages/daemon/src/memory/memory-hybrid.ts`)

```ts
export interface RankedCandidate {
  readonly documentId: number;
  /** 1-based rank within one leg's ordering. */
  readonly rank: number;
}

/**
 * Reciprocal Rank Fusion across legs: fused(d) = Σ 1/(k + rank_i(d)).
 * Ties break toward lower BM25 rank (legs are passed BM25-first).
 * Returns up to `cap` documents, best first.
 */
export function rrfFuse(
  legs: readonly (readonly RankedCandidate[])[],
  k: number,
  cap: number,
): { documentId: number; fused: number }[];

/**
 * Stage 1. Runs the BM25 leg (existing searchMemoryFts SQL at pool size) and the vector leg
 * (searchMemoryVectorDocs, SQL or JS depending on memory.vector.enabled), fuses, and returns
 * the fused pool with normalized scores (best = 1.0) alongside raw order for stage 2.
 */
export function searchMemoryStage1(db: Database.Database, opts: Stage1Options): FusedPool;

export interface FusedPool {
  /** Ordered by fused score desc; capped at bm25Candidates + vectorCandidates. */
  readonly candidates: readonly { documentId: number; fused: number }[];
  /** documentId → normalized fused score (0, 1], best = 1.0. */
  readonly normalized: ReadonlyMap<number, number>;
}
```

### Reranker dependency (prerequisite: issue #273)

**Not implemented by this plan.** Contract assumed from `@shoggoth/models` (Cohere `/v1/rerank` semantics); reconcile through a plan addendum if the delivered interface differs.

```ts
export interface RerankRequest {
  readonly query: string;
  /** Candidates in fused order; strings are `title + body` truncated to MAX_RERANK_CHARS. */
  readonly documents: readonly string[];
  /** Ask the provider to return at most this many results. */
  readonly topN?: number;
}

export interface RerankResultItem {
  /** Index into `documents`. */
  readonly index: number;
  /** Graded relevance, 0–1. */
  readonly relevanceScore: number;
}

export interface RerankResponse {
  readonly results: readonly RerankResultItem[];
}

export interface Reranker {
  rerank(request: RerankRequest): Promise<RerankResponse>;
}
```

A reranker is optional: `runMemoryBuiltin` accepts it as an injectable dependency (`rerank?: Reranker`), so tests and configurations without #273 simply run without stage 2.

### Stage 2 (`packages/daemon/src/memory/memory-rerank.ts`)

```ts
export const MAX_RERANK_CHARS = 4_000;

export interface RerankInput {
  readonly query: string;
  /** Fused pool + documents, already truncated for transport. */
  readonly candidates: readonly { documentId: number; body: string }[];
  readonly timeoutMs: number;
}

/**
 * Reorder `candidates` by relevanceScore. Never throws:
 * - provider omits an index → that candidate keeps its fused position after scored ones
 * - throw / timeout / malformed payload → returns the input order untouched
 */
export async function rerankCandidates(
  reranker: Reranker | undefined,
  input: RerankInput,
): Promise<{ documentId: number; score: number }[]>;
```

### Tool handler (`packages/daemon/src/memory/builtin-memory-tools.ts`)

```ts
export interface RunMemoryBuiltinInput {
  // existing fields…
  /** Stage-2 reranker from #273; absent → rerank disabled regardless of config. */
  readonly rerank?: Reranker;
}
```

`memory-search` args gain `rerank?: boolean` (explicit per-call override of `memory.rerank.enabled`).

## Data Structures / Schemas

### Migration `0020_memory_chunks.sql`

```sql
CREATE TABLE memory_chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES memory_documents (id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  UNIQUE (document_id, ordinal)
);

CREATE INDEX idx_memory_chunks_document ON memory_chunks (document_id);

CREATE TABLE chunk_embeddings (
  chunk_id INTEGER NOT NULL REFERENCES memory_chunks (id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chunk_id, model_id)
);
```

Rowid tables with float32 BLOB vector columns — the shape `vector_init` requires.

### Score semantics

| Flags                     | `score` provenance                                                        | `min_score` compares against        |
| ------------------------- | ------------------------------------------------------------------------- | ----------------------------------- |
| all off (default)         | unchanged: BM25 min-max, or cosine similarity on the vector path          | as today                            |
| `hybrid` on, `rerank` off | normalized RRF (best candidate = 1.0, rank-derived)                       | RRF-normalized score (conservative) |
| `rerank` on               | `relevanceScore` from #273 (0–1); unscored candidates keep normalized RRF | relevance score                     |

`include_scores` is unchanged in shape; only provenance differs per mode.

### Config fragment example

```jsonc
{
  "memory": {
    "embeddings": { "enabled": true },
    "vector": { "enabled": true },
    "hybrid": { "enabled": true, "bm25Candidates": 50, "vectorCandidates": 50, "rrfK": 60 },
    "rerank": { "enabled": true, "candidates": 20, "timeoutMs": 3000 },
  },
}
```

## Code Examples

```ts
// Stage 1 + 2 inside runMemoryBuiltin("memory-search", …)
const pool = searchMemoryStage1(db, {
  textQuery: query,
  limit, // final tool limit
  filters,
  embeddingsEnabled: memory.embeddings.enabled,
  queryEmbedding, // existing OpenAI-compatible fetch, unchanged
  embeddingModelId: modelId,
  vectorEnabled: memory.vector?.enabled ?? false,
});

const order =
  memory.rerank?.enabled && args.rerank !== false
    ? await rerankCandidates(input.rerank, {
        query,
        candidates: pool.candidates.slice(0, memory.rerank.candidates).map(toRerankDoc),
        timeoutMs: memory.rerank.timeoutMs,
      })
    : pool.candidates.map((c) => ({ documentId: c.documentId, score: c.fused }));

const hits = order.slice(0, limit).map((o) => ({
  ...docById(o.documentId),
  score: o.score,
}));
```

```ts
// Per-connection vector readiness (lazy, idempotent)
if (vectorEnabled && ensureVectorReady(db, "chunks", modelId)) {
  vectorHits = searchMemoryVectorDocs(db, {
    query: queryEmbedding,
    modelId,
    limit: vectorCandidates,
    filters,
  });
}
```
