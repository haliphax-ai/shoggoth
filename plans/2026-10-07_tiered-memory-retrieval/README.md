---
date: 2026-10-07
completed: never
---

# Tiered Memory Retrieval

## Summary

Rebuilds `memory-search` as a two-stage ("tiered") retrieval pipeline: stage 1 recalls candidates in parallel through BM25 (FTS5) and vector similarity (SIMD scan executed inside SQLite by the `sqlite-vector` extension), fuses them with Reciprocal Rank Fusion; stage 2 passes the fused pool through the reranker delivered by [#273](https://github.com/haliphax-ai/shoggoth/issues/273) for final ordering. All three stages sit behind opt-in config flags whose defaults leave current behavior byte-identical.

## Motivation

Today memory search is single-leg and either/or:

- BM25 over `memory_fts` — the default path.
- When `memory.embeddings.enabled` and the embeddings API are healthy, the vector path _replaces_ BM25 entirely (`searchMemoryWithOptionalEmbedding`), so keyword recall is discarded the moment embeddings come online.
- The vector path performs **no vector operations in SQLite**: it `SELECT`s every embedding row for the model across the FFI boundary and computes cosine in JavaScript, one full-table scan per query. It scales linearly with the corpus and wastes the fact that `memory_embeddings.embedding` is already a float32 BLOB column.
- Embeddings are generated from **whole file bodies**. Documents over the embedding model's token limit (e.g. 100 KB+ daily logs) fail, the error is swallowed, and the largest, most valuable documents silently end up with no vector representation at all.

This plan adds the missing retrieval machinery: vector search performed inside SQLite by [`sqlite-vector`](https://github.com/sqliteai/sqlite-vector), fusion of both recall legs, chunk-level embeddings so every document is representable, and a reranking pass on top — consuming the reranker that [#273](https://github.com/haliphax-ai/shoggoth/issues/273) introduces as a prerequisite (its implementation is explicitly out of scope here).

## Design

```
query
  │
  ├─ Stage 1a  BM25 recall      FTS5 top-N documents (existing searchMemoryFts, widened)
  ├─ Stage 1b  vector recall    vector_full_scan top-N (SQL-side SIMD; chunk or document
  │                             granularity, aggregated to documents)
  ▼
dedupe by document id → Reciprocal Rank Fusion (k=60) → fused pool (top `rerank.candidates`)
  │
  └─ Stage 2  rerank            consumes #273 reranker (Cohere-style contract) → final `limit`
                                ordered by relevance score (0–1); any failure falls back to
                                the fused order (circuit breaker, like `embeddingsHealthy`)
```

### Stage 1 — recall

- **BM25 leg:** the existing `searchMemoryFts` SQL, run with a candidate pool limit (`hybrid.bm25Candidates`, default 50) instead of the final `limit`. Path/date filters apply as they do today.
- **Vector leg:** new `memory-vector.ts`. The query embedding is encoded as a float32 BLOB and scanned with `vector_full_scan(table, column, ?, N)` — streaming mode (no `k`) so `WHERE` filters compose, `ORDER BY distance LIMIT N`. COSINE distance maps to the existing score semantics as `score = 1 - distance`. Target table is `chunk_embeddings` once Phase 3 lands, aggregated to parent documents with `MIN(distance)`; `memory_embeddings` before that.
- **Fusion:** Reciprocal Rank Fusion — `fused(d) = Σ 1/(rrfK + rank_i(d))` over the rankings each leg produced (rank starts at 1). RRF needs no cross-score normalization (BM25 and cosine scales are incompatible), which also removes the current ad-hoc min-max rescaling as the thing that defines score semantics. Ties break toward the BM25 order. Pool capped at `hybrid.bm25Candidates + hybrid.vectorCandidates` distinct documents before stage 2.

### Stage 2 — rerank (prerequisite: #273)

Out of scope to build, in scope to consume. This plan assumes #273 ships a Cohere-style rerank capability in `@shoggoth/models` matching the contract in [`spec.md`](spec.md#reranker-dependency-prerequisite-issue-273); when the real interface lands, reconcile via a plan addendum rather than a rewrite. The memory side passes the fused candidates (title + truncated body, bounded by `MAX_RERANK_CHARS`) and reorders by `relevanceScore`. Timeout (`rerank.timeoutMs`, default 3 s), transport errors, or a malformed response drop to the fused order — a rerank pass never fails a search.

### sqlite-vector integration

- New daemon dependency `@sqliteai/sqlite-vector` (Apache-2.0; prebuilt binaries for linux x86_64/arm64 in glibc and musl flavors, shipped as npm `optionalDependencies`, so the existing Docker `npm ci` / `npm prune --omit=dev` build picks the right one up unchanged).
- Loaded per connection via `db.loadExtension(getExtensionPath())` — the extension's own documented example targets better-sqlite3.
- `vector_init(table, column, 'dimension=N,type=FLOAT32,distance=COSINE')` must be executed on **every connection** that runs vector queries, so the daemon uses a lazy, idempotent `ensureVectorReady(db, …)` helper invoked before the first vector query on a handle (dimension read from stored rows). Connections that never search (CLI subcommands, tests) never pay for it.
- **No schema change for document vectors**: `memory_embeddings.embedding` is already a float32 BLOB on a rowid table — exactly what the extension expects.
- If the extension cannot load (unsupported platform, load error), the feature flag degrades to the existing JS cosine path; nothing about search availability depends on the native binary.
- Quantization (`vector_quantize`) is deliberately deferred: scans are brute-force SIMD, sub-millisecond at this corpus size (hundreds of rows, ~1–2 MB of vectors). ANN territory starts far beyond where this deployment sits.

### Chunked embeddings

Heading-aware chunking (~4 000 chars ≈ 1 000 tokens using the codebase's chars/4 heuristic, 200-char overlap, frontmatter stripped) into new `memory_chunks` rows, each embedded separately into `chunk_embeddings` and keyed by content hash so unchanged chunks are never re-embedded. This is what makes the vector leg trustworthy: every document gets a representation regardless of size, and small units are exactly what a reranker scores best. Chunking replaces the whole-file sync in `syncMemoryEmbeddingsAfterIngest`; the legacy `memory_embeddings` table stays but stops being written (drop deferred to a future cleanup).

### Config (`@shoggoth/shared`)

Three new optional sub-sections under `memory`, all defaulting to off:

- `memory.vector: { enabled }` — SQL scan instead of the JS cosine path.
- `memory.hybrid: { enabled, bm25Candidates, vectorCandidates, rrfK }` — fusion of both legs instead of either/or.
- `memory.rerank: { enabled, candidates, timeoutMs }` — stage 2, requires #273's rerank configuration to be present.

Defaults keep today's behavior exactly; the flags are the rollout plan (vector → hybrid → rerank) and each one is independently reversible. `hybrid.enabled` without `embeddings.enabled`, or `rerank.enabled` without a resolvable reranker, logs a warning and degrades to the best available stage rather than erroring.

### Tool surface

`memory-search` keeps its parameters and gains one optional boolean, `rerank`, to override the configured stage-2 behavior per call. Response shape is unchanged; only score provenance differs (see [`spec.md`](spec.md#score-semantics)).

## Testing Strategy

Tests written before the implementation committed against them; `packages/daemon` and `packages/shared` suites plus `tsc --noEmit` must stay green throughout.

- **Vector leg** (`test/memory/memory-vector.test.ts`): extension load + `vector_version()` (skipped cleanly when the platform binary is absent), `vector_init` idempotency, ordered distances on a seeded table, filter composition, fallback to the JS path when load fails.
- **Fusion** (`test/memory/memory-hybrid.test.ts`): `rrfFuse` unit cases (disjoint/overlapping/partial rankings, tie-break, pool cap), hybrid orchestration (one leg empty, both legs, filters, `min_score`), and a regression guard asserting flags-off behavior is byte-identical to the legacy paths.
- **Chunking** (`test/memory/memory-chunk.test.ts`): heading boundaries, size/overlap limits, frontmatter handling, hash-based skip, and an oversized (100 KB) document successfully embedding end-to-end with a mocked embeddings API. Migration pickup is covered by the existing `test/db/persistence.test.ts` (it asserts every numbered migration applies).
- **Rerank** (`test/memory/memory-rerank.test.ts`): happy-path reorder, pool truncation to `candidates`, reranker omitted, throw/timeout/malformed response each returning the fused order unchanged.
- **Schema/tool-surface**: config defaults, strictness, fragment parsing; `memorySearchArgs` accepts `rerank`.
- **Manual/verification**: `SELECT vector_backend()` in the running container, side-by-side latency of JS vs SQL vector path against the real state DB, `npm run lint` + `typecheck`.

## Considerations

- **Prerequisite dependency:** #273 (reranking; later, decision support) is assumed delivered with a Cohere-style contract. Phases 1–3 do not depend on it and ship regardless; phase 4 rebases onto the real interface via an addendum.
- **Decision support is out of scope.** This plan ranks and retrieves; it does not interpret rankings as decisions.
- **Not an ANN index.** `sqlite-vector` is exact/quantized brute-force SIMD — right for this scale, wrong mental model for "vector database". Revisit only past ~50k vectors, which would mean `vector_quantize` (adds init/re-quantize bookkeeping and recall tuning).
- **One embedding model at a time.** A vector column has a single fixed dimension; changing `embeddings.modelId` across dimensions requires re-embedding (ingest hash mismatch already triggers re-embed, but the column's `dimension` must be re-`vector_init`ed — the helper reads it from stored rows, so ordering matters).
- **Score semantics shift when flags turn on** (normalized RRF is rank-derived, rerank score is graded relevance). `min_score` behaves differently per mode; documented, not reconciled — RRF-normalized scores are intentionally conservative.
- **Rerank payload budget:** bodies are truncated (`MAX_RERANK_CHARS`) before being sent to the reranker; reranking operates on the fused pool, not the corpus.
- **`memory_embeddings` becomes dead weight** after Phase 3 (kept, unwritten). Dropping it is deferred.
- **Native binary availability:** an unsupported platform degrades that leg to JS, but tests must skip rather than fail when the binary is missing, or CI on odd architectures breaks.
- Out of scope: workflow-engine memory retrieval, MCP-server consumers beyond the builtin catalog, per-agent memory flag overrides, embedding-provider changes.

## Migration

One additive migration, `0020_memory_chunks.sql`, creating `memory_chunks` and `chunk_embeddings` (FK cascade on document delete). Existing tables are untouched, all new config keys are optional with off-by-default values, and chunk backfill happens lazily on the next `memory-ingest` per root — an existing deployment upgrades and changes nothing until an operator flips a flag.

## References

- [`spec.md`](spec.md) — type signatures, config schemas, SQL, and the #273 reranker contract this plan assumes
- [`implementation.md`](implementation.md) — phased implementation steps
- [#273 — reranking support](https://github.com/haliphax-ai/shoggoth/issues/273) (prerequisite)
- [sqlite-vector](https://github.com/sqliteai/sqlite-vector) · [API reference](https://github.com/sqliteai/sqlite-vector/blob/main/API.md)
- Existing implementation: `packages/daemon/src/memory/` (`memory-index.ts`, `builtin-memory-tools.ts`), `migrations/0001_schema.sql`
