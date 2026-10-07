# Implementation

Pre-flight (not a phase, not committed): a throwaway script under the workspace `tmp/` that installs `@sqliteai/sqlite-vector`, runs `db.loadExtension(getExtensionPath())`, `SELECT vector_version()`, `vector_init`, and a `vector_full_scan` against a copy of the real state DB. ~30 minutes; if the extension will not load against better-sqlite3's bundled SQLite on this platform, stop and report before any phase starts.

Every phase below is additive and independently shippable; flags default off, so each phase lands with byte-identical runtime behavior until an operator opts in. No phase introduces a breaking change.

## Phase 1: Config schema (`@shoggoth/shared`)

Additive config surface for all three stages.

- Add `shoggothMemoryVectorConfigSchema`, `shoggothMemoryHybridConfigSchema`, `shoggothMemoryRerankConfigSchema` to `packages/shared/src/schema/memory.ts` with the defaults from [`spec.md`](spec.md).
- Add optional `vector` / `hybrid` / `rerank` keys to `shoggothMemoryConfigSchema` and extend `DEFAULT_MEMORY_CONFIG`.
- Mirror the `embeddings` pattern for the per-agent memory fragment and any global `memory` occurrence in `packages/shared/src/schema/config.ts` (`.partial().optional()`).
- Export the new schemas/types from the existing memory module barrels (`schema.ts`, `index.ts`).
- Tests: config parse with no new keys (unchanged defaults), explicit values, strictness (unknown keys rejected), fragment merge.

**Files:**

- `packages/shared/src/schema/memory.ts`
- `packages/shared/src/schema/config.ts`
- `packages/shared/src/schema.ts`
- `packages/shared/src/index.ts`
- `packages/shared/test/schema-memory.test.ts` (extend existing or create)

## Phase 2: Vector leg via sqlite-vector (daemon)

SQL-side SIMD scan replacing the JS cosine path when opted in; JS path remains the fallback.

- Add `@sqliteai/sqlite-vector` to `packages/daemon/package.json`.
- Create `packages/daemon/src/memory/memory-vector.ts`: `loadVectorExtension`, `ensureVectorReady` (idempotent per connection, dimension read from a stored row), `vectorSearchAvailable`, `searchMemoryVectorDocs` (streaming `vector_full_scan`, filters composed in SQL, `MIN(1 - distance)` aggregation per document).
- `memory-index.ts`: `searchMemoryWithOptionalEmbedding` gains a vector-provider branch — when `memory.vector.enabled` and `ensureVectorReady(...)`, run `searchMemoryVectorDocs`; otherwise the existing JS scan. Score = `1 - distance`, identical semantics to today's cosine similarity.
- Tests: extension smoke (skip cleanly when the platform binary is absent), `vector_init` idempotency, ordering/`MIN` aggregation on seeded rows, filter composition, flag-off and load-failure fallback to JS.

**Files:**

- `packages/daemon/package.json`
- `packages/daemon/package-lock.json` (workspace root lockfile)
- `packages/daemon/src/memory/memory-vector.ts`
- `packages/daemon/src/memory/memory-index.ts`
- `packages/daemon/test/memory/memory-vector.test.ts`

## Phase 3: Hybrid fusion — stage 1 recall (daemon)

BM25 and vector legs run together and fuse, replacing either/or when opted in.

- Create `packages/daemon/src/memory/memory-hybrid.ts`: `rrfFuse` (pure, unit-testable) and `searchMemoryStage1` (both legs at pool size, dedupe by document id, normalized fused scores, tie-break toward BM25).
- `builtin-memory-tools.ts`: when `memory.hybrid.enabled`, route `memory-search` through stage 1 (and stage 2 untouched until Phase 5); apply `min_score`/`include_scores` per the score-semantics table in [`spec.md`](spec.md); keep the legacy path untouched when the flag is off.
- Non-obvious detail: the vector leg reuses the query-embedding fetch already in `memory-search`; when it fails, stage 1 degrades to BM25-only for that call (same circuit-breaker shape as `embeddingsHealthy`).
- Tests: `rrfFuse` units (disjoint/overlap/partial, tie-break, cap), orchestration (vector leg empty, BM25 leg empty, both, filters), normalized scores, flags-off regression.

**Files:**

- `packages/daemon/src/memory/memory-hybrid.ts`
- `packages/daemon/src/memory/builtin-memory-tools.ts`
- `packages/daemon/test/memory/memory-hybrid.test.ts`

## Phase 4: Chunked embeddings

Migration + chunker + ingest rewiring; the vector leg upgrades from document to chunk granularity.

- `migrations/0020_memory_chunks.sql` — `memory_chunks` + `chunk_embeddings` exactly as in [`spec.md`](spec.md#migration-0020_memory_chunks.sql).
- Create `packages/daemon/src/memory/memory-chunk.ts`: `chunkMarkdown(body, opts)` (frontmatter stripped, heading-aware, ≤ 4 000 chars per chunk with 200-char overlap) and `syncChunkEmbeddings(...)` (per-chunk `content_sha256` skip, OpenAI-compatible fetch, upsert).
- `builtin-memory-tools.ts`: replace `syncMemoryEmbeddingsAfterIngest`'s whole-file loop with chunk sync (the old function's doc-level writes stop; `memory_embeddings` remains populated read-only for anything still referencing it). This fixes the oversized-document embed failure.
- `memory-vector.ts`: `ensureVectorReady`/`searchMemoryVectorDocs` switch their target to `chunks` (`chunk_embeddings` aggregated to `document_id` via `MIN(distance)`); document target kept for the pre-chunk fallback.
- Tests: chunker boundaries/sizes/overlap/frontmatter, hash-skip on unchanged chunks, 100 KB document embedding end-to-end with a mocked embeddings API (the regression this phase exists for), cascade delete, migration pickup (existing `test/db/persistence.test.ts` covers application; extend its table assertions).

**Files:**

- `migrations/0020_memory_chunks.sql`
- `packages/daemon/src/memory/memory-chunk.ts`
- `packages/daemon/src/memory/builtin-memory-tools.ts`
- `packages/daemon/src/memory/memory-vector.ts`
- `packages/daemon/test/memory/memory-chunk.test.ts`
- `packages/daemon/test/db/persistence.test.ts`

## Phase 5: Stage 2 rerank (prerequisite: #273 — rebase onto its final interface)

Consumes the reranker; builds none of it. **Blocked by #273** — everything else ships without it.

- Create `packages/daemon/src/memory/memory-rerank.ts`: `rerankCandidates` (pool truncation to `memory.rerank.candidates`, body truncation to `MAX_RERANK_CHARS`, timeout wrapper, never-throw fallback to fused order, unscored indexes keep fused position).
- `builtin-memory-tools.ts`: `RunMemoryBuiltinInput.rerank?: Reranker` dependency; after stage 1, run stage 2 when `memory.rerank.enabled && args.rerank !== false && reranker present`; score provenance per the semantics table.
- `sessions/builtin-handlers/memory-handlers.ts`: construct the `Reranker` from config (via whatever factory #273 ships) and pass it in; absent config ⇒ leave the dependency undefined.
- Tests: reorder happy path, pool/body truncation, omitted dependency, throw/timeout/malformed payload each returning the fused order, `rerank: false` override.

**Files:**

- `packages/daemon/src/memory/memory-rerank.ts`
- `packages/daemon/src/memory/builtin-memory-tools.ts`
- `packages/daemon/src/sessions/builtin-handlers/memory-handlers.ts`
- `packages/daemon/test/memory/memory-rerank.test.ts`

## Phase 6: Tool surface + docs

- `packages/mcp-integration/src/builtin-tool-schemas.ts`: `memorySearchArgs` gains optional `rerank` boolean; `builtin-shoggoth-tools.ts` description updated to describe the tiered pipeline (BM25 + vector recall, optional rerank).
- `docs/tools/builtin-memory.md`: new param, score-provenance table, flag guidance.
- `docs/daemon.md`: memory retrieval section (pipeline diagram, flags, fallbacks, per-connection `vector_init`, extension availability).
- `docs/shared.md`: `ShoggothMemoryVectorConfig`/`Hybrid`/`Rerank` rows and defaults constants.
- `docs/mcp-integration.md`: memory tool descriptions.
- Regression: full `packages/daemon`, `packages/shared`, `packages/mcp-integration` vitest suites + `tsc --noEmit` + `npm run lint`.

**Files:**

- `packages/mcp-integration/src/builtin-tool-schemas.ts`
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts`
- `docs/tools/builtin-memory.md`
- `docs/daemon.md`
- `docs/shared.md`
- `docs/mcp-integration.md`
