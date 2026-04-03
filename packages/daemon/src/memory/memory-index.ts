import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { extname, join, matchesGlob, relative } from "node:path";
import type Database from "better-sqlite3";

export interface MemoryHit {
  readonly id: number;
  readonly sourcePath: string;
  readonly title: string;
  readonly body: string;
  /** Relevance score in 0.0–1.0 range; present only when requested. */
  readonly score?: number | null;
}

// ---------------------------------------------------------------------------
// Ingest types
// ---------------------------------------------------------------------------

/** Describes a single file change during ingest. */
interface IngestFileChange {
  readonly path: string;
  readonly status: "added" | "updated" | "removed";
}

/** Result returned by ingestMemoryRoots. */
interface IngestResult {
  /** Number of files added, updated, or removed. */
  readonly changed: number;
  /** Detailed list of affected files. Always populated internally; caller decides whether to expose it. */
  readonly files: IngestFileChange[];
}

/** Options for scoped / filtered ingest. */
export interface IngestOptions {
  /**
   * Glob patterns or literal paths to restrict which files are ingested.
   * When omitted or empty, all markdown files under the roots are ingested (current behavior).
   * Patterns are matched against the path relative to each root.
   */
  readonly paths?: readonly string[];
  /**
   * Glob patterns to exclude from the ingest scope. Applied after `paths` resolution.
   * Patterns are matched against the path relative to each root.
   */
  readonly exclude?: readonly string[];
}

/** Filters applied to memory search queries. */
export interface MemorySearchFilters {
  /** Only return results whose sourcePath starts with this prefix. */
  readonly pathPrefix?: string | null;
  /** Only return results modified on or after this timestamp (ms since epoch). */
  readonly afterMs?: number | null;
  /** Only return results modified before this timestamp (ms since epoch). */
  readonly beforeMs?: number | null;
}

/** Strip BOM, optional YAML frontmatter; title from frontmatter or first `#` line. */
export function parseMarkdownForMemory(source: string): { title: string; body: string } {
  let rest = source.replace(/^\uFEFF/, "");
  let title = "";

  if (rest.startsWith("---")) {
    const end = rest.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = rest.slice(3, end).trim();
      rest = rest.slice(end + 4).replace(/^\n/, "");
      for (const line of fm.split("\n")) {
        const m = line.match(/^\s*title\s*:\s*(.+?)\s*$/i);
        if (m) {
          title = m[1]!.trim().replace(/^["']|["']$/g, "");
          break;
        }
      }
    }
  }

  const lines = rest.split(/\r?\n/);
  if (!title) {
    for (const line of lines) {
      const hm = line.match(/^#\s+(.+?)\s*$/);
      if (hm) {
        title = hm[1]!.trim();
        break;
      }
    }
  }

  return { title, body: rest.trim() };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function* walkMarkdownFiles(root: string): Generator<string> {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) yield* walkMarkdownFiles(full);
    else if (e.isFile() && extname(e.name).toLowerCase() === ".md") yield full;
  }
}

/** Token-safe FTS5 query: AND of double-quoted phrases (handles most specials). */
export function buildFtsQuery(userInput: string): string {
  const tokens = userInput
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}

// ---------------------------------------------------------------------------
// Glob / path filtering helpers
// ---------------------------------------------------------------------------

/**
 * Check whether `relPath` (relative to a root) passes the include/exclude filters.
 * When `includePats` is empty, all files pass the include check.
 */
function fileMatchesFilters(
  relPath: string,
  absPath: string,
  includePats: readonly string[],
  excludePats: readonly string[],
): boolean {
  // Include check: if patterns are specified, at least one must match.
  if (includePats.length > 0) {
    const matched = includePats.some((pat) => {
      // Literal path match (exact relative or absolute).
      if (pat === relPath || pat === absPath) return true;
      // Glob match against relative path.
      try {
        return matchesGlob(relPath, pat);
      } catch {
        return false;
      }
    });
    if (!matched) return false;
  }

  // Exclude check: if any pattern matches, the file is excluded.
  if (excludePats.length > 0) {
    const excluded = excludePats.some((pat) => {
      try {
        return matchesGlob(relPath, pat);
      } catch {
        return false;
      }
    });
    if (excluded) return false;
  }

  return true;
}

/**
 * Scan absolute directory roots for `*.md`, upsert into `memory_documents` / FTS.
 *
 * When `opts.paths` or `opts.exclude` are provided, only matching files are processed.
 * Scoped ingests do not remove index entries for files outside the specified scope.
 * Full (unscoped) ingests detect and remove stale entries for files that no longer exist on disk.
 *
 * @returns An `IngestResult` with the count and detailed list of affected files.
 */
export function ingestMemoryRoots(
  db: Database.Database,
  absoluteRoots: string[],
  opts?: IngestOptions,
): IngestResult {
  const files: IngestFileChange[] = [];
  const includePats = opts?.paths ?? [];
  const excludePats = opts?.exclude ?? [];
  const isScoped = includePats.length > 0 || excludePats.length > 0;

  const select = db.prepare(
    "SELECT id, content_sha256 FROM memory_documents WHERE source_path = @path",
  );
  const insert = db.prepare(`
    INSERT INTO memory_documents (source_path, title, body, content_sha256, source_mtime_ms)
    VALUES (@path, @title, @body, @hash, @mtime)
  `);
  const update = db.prepare(`
    UPDATE memory_documents
    SET title = @title, body = @body, content_sha256 = @hash, source_mtime_ms = @mtime,
        ingested_at = datetime('now')
    WHERE id = @id
  `);
  const deleteDoc = db.prepare("DELETE FROM memory_documents WHERE id = @id");

  const run = db.transaction((roots: string[]) => {
    // Track which absolute paths we visited so we can detect removals.
    const visitedPaths = new Set<string>();

    for (const root of roots) {
      const realRoot = realpathSync(root);

      for (const filePath of walkMarkdownFiles(realRoot)) {
        const abs = realpathSync(filePath);
        const rel = relative(realRoot, abs);

        // Apply include/exclude filters when scoped.
        if (isScoped && !fileMatchesFilters(rel, abs, includePats, excludePats)) {
          continue;
        }

        visitedPaths.add(abs);

        const raw = readFileSync(abs, "utf8");
        const { title, body } = parseMarkdownForMemory(raw);
        const hash = sha256Hex(body);
        const st = statSync(abs);
        const mtimeMs = Math.trunc(st.mtimeMs);
        const row = select.get({ path: abs }) as
          | { id: number; content_sha256: string }
          | undefined;
        if (row && row.content_sha256 === hash) continue;

        if (row) {
          update.run({
            id: row.id,
            title: title || null,
            body,
            hash,
            mtime: mtimeMs,
          });
          files.push({ path: abs, status: "updated" });
        } else {
          insert.run({
            path: abs,
            title: title || null,
            body,
            hash,
            mtime: mtimeMs,
          });
          files.push({ path: abs, status: "added" });
        }
      }
    }

    // Detect removed files: query existing index entries under these roots
    // and remove any that no longer exist on disk.
    // For scoped ingests, only check files that match the scope filters.
    const allDocs = db
      .prepare("SELECT id, source_path FROM memory_documents")
      .all() as { id: number; source_path: string }[];

    for (const doc of allDocs) {
      // Only consider documents under one of the scanned roots.
      let underRoot = false;
      let docRelPath = "";
      let docRealRoot = "";
      for (const root of roots) {
        const realRoot = realpathSync(root);
        const normalizedRoot = realRoot.endsWith("/") ? realRoot : `${realRoot}/`;
        if (doc.source_path === realRoot || doc.source_path.startsWith(normalizedRoot)) {
          underRoot = true;
          docRelPath = relative(realRoot, doc.source_path);
          docRealRoot = realRoot;
          break;
        }
      }
      if (!underRoot) continue;

      // For scoped ingests, only remove files that match the scope.
      if (isScoped && !fileMatchesFilters(docRelPath, doc.source_path, includePats, excludePats)) {
        continue;
      }

      // If the file was visited during the walk, it still exists — skip.
      if (visitedPaths.has(doc.source_path)) continue;

      // File is gone from disk (or no longer matches). Remove from index.
      if (!existsSync(doc.source_path)) {
        deleteDoc.run({ id: doc.id });
        files.push({ path: doc.source_path, status: "removed" });
      }
    }
  });

  run(absoluteRoots);

  return {
    changed: files.length,
    files,
  };
}

export function searchMemoryFts(
  db: Database.Database,
  query: string,
  opts: { limit: number; includeScores?: boolean; minScore?: number; filters?: MemorySearchFilters },
): MemoryHit[] {
  const fts = buildFtsQuery(query);
  if (!fts) return [];

  const filters = opts.filters;
  const whereClauses: string[] = ["memory_fts MATCH @match"];
  const params: Record<string, unknown> = { match: fts, lim: opts.limit };

  if (filters?.pathPrefix) {
    const prefix = filters.pathPrefix.replace(/\/+$/, "");
    whereClauses.push("(d.source_path = @pathExact OR d.source_path LIKE @pathLike)");
    params.pathExact = prefix;
    params.pathLike = `${prefix}/%`;
  }
  if (filters?.afterMs != null) {
    whereClauses.push("d.source_mtime_ms >= @afterMs");
    params.afterMs = filters.afterMs;
  }
  if (filters?.beforeMs != null) {
    whereClauses.push("d.source_mtime_ms < @beforeMs");
    params.beforeMs = filters.beforeMs;
  }

  const sql = `
    SELECT d.id AS id, d.source_path AS sourcePath, d.title AS title, d.body AS body,
           bm25(memory_fts) AS bm25Score
    FROM memory_fts
    JOIN memory_documents d ON d.id = memory_fts.rowid
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY bm25(memory_fts)
    LIMIT @lim
  `;

  const rows = db.prepare(sql).all(params) as (MemoryHit & { bm25Score: number })[];

  // BM25 returns negative values (lower = better). Normalize to 0.0–1.0 range.
  const scores = rows.map((r) => r.bm25Score);
  const minBm25 = scores.length > 0 ? Math.min(...scores) : 0;
  const maxBm25 = scores.length > 0 ? Math.max(...scores) : 0;
  const range = maxBm25 - minBm25;

  let results: MemoryHit[] = rows.map((r) => {
    // Normalize: best match (most negative bm25) → 1.0, worst → close to 0.
    // Single result gets score 1.0.
    const normalized = range === 0 ? 1.0 : (maxBm25 - r.bm25Score) / range;
    // Clamp to [0.01, 1.0] — any FTS match has some relevance.
    const score = Math.max(0.01, Math.min(1.0, normalized));
    return {
      id: r.id,
      sourcePath: r.sourcePath,
      title: r.title ?? "",
      body: r.body,
      ...(opts.includeScores ? { score } : {}),
    };
  });

  // Apply min_score filter when scores are requested.
  if (opts.includeScores && opts.minScore != null && opts.minScore > 0) {
    results = results.filter((r) => (r.score ?? 0) >= opts.minScore!);
  }

  return results;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function float32FromBlob(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function upsertMemoryEmbedding(
  db: Database.Database,
  documentId: number,
  modelId: string,
  embedding: Float32Array,
  contentSha256?: string | null,
): void {
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.prepare(`
    INSERT INTO memory_embeddings (document_id, model_id, embedding, dimensions, content_sha256)
    VALUES (@doc, @model, @emb, @dim, @hash)
    ON CONFLICT(document_id, model_id) DO UPDATE SET
      embedding = excluded.embedding,
      dimensions = excluded.dimensions,
      content_sha256 = excluded.content_sha256,
      updated_at = datetime('now')
  `).run({
    doc: documentId,
    model: modelId,
    emb: buf,
    dim: embedding.length,
    hash: contentSha256 ?? null,
  });
}

export interface SearchMemoryHybridOptions {
  readonly textQuery: string;
  readonly limit: number;
  readonly embeddingsEnabled?: boolean;
  /** When false, skip vector ranking and use BM25 (provider unhealthy / circuit-broken). */
  readonly embeddingsHealthy?: boolean;
  readonly queryEmbedding?: Float32Array | null;
  readonly embeddingModelId?: string;
  readonly includeScores?: boolean;
  readonly minScore?: number;
  readonly filters?: MemorySearchFilters;
}

/**
 * When embeddings are enabled and a query vector + model id are provided and at least one
 * stored embedding exists for that model, rank by cosine similarity. Otherwise FTS (BM25).
 */
export function searchMemoryWithOptionalEmbedding(
  db: Database.Database,
  opts: SearchMemoryHybridOptions,
): MemoryHit[] {
  const { textQuery, limit, includeScores, minScore, filters } = opts;
  const modelId = opts.embeddingModelId ?? "default";
  const qEmb = opts.queryEmbedding;
  const embOn = opts.embeddingsEnabled === true && qEmb != null && qEmb.length > 0;
  const embHealthy = opts.embeddingsHealthy !== false;

  const countEmb = db
    .prepare("SELECT COUNT(*) AS c FROM memory_embeddings WHERE model_id = @m")
    .get({ m: modelId }) as { c: number };

  if (!embOn || countEmb.c === 0 || !embHealthy) {
    return searchMemoryFts(db, textQuery, { limit, includeScores, minScore, filters });
  }

  // Build WHERE clauses for embedding-based search.
  const whereClauses: string[] = ["e.model_id = @model"];
  const params: Record<string, unknown> = { model: modelId };

  if (filters?.pathPrefix) {
    const prefix = filters.pathPrefix.replace(/\/+$/, "");
    whereClauses.push("(d.source_path = @pathExact OR d.source_path LIKE @pathLike)");
    params.pathExact = prefix;
    params.pathLike = `${prefix}/%`;
  }
  if (filters?.afterMs != null) {
    whereClauses.push("d.source_mtime_ms >= @afterMs");
    params.afterMs = filters.afterMs;
  }
  if (filters?.beforeMs != null) {
    whereClauses.push("d.source_mtime_ms < @beforeMs");
    params.beforeMs = filters.beforeMs;
  }

  const rows = db
    .prepare(
      `
    SELECT d.id AS id, d.source_path AS sourcePath, d.title AS title, d.body AS body, e.embedding AS embedding
    FROM memory_embeddings e
    JOIN memory_documents d ON d.id = e.document_id
    WHERE ${whereClauses.join(" AND ")}
  `,
    )
    .all(params) as {
    id: number;
    sourcePath: string;
    title: string | null;
    body: string;
    embedding: Buffer;
  }[];

  const scored = rows.map((r) => ({
    hit: {
      id: r.id,
      sourcePath: r.sourcePath,
      title: r.title ?? "",
      body: r.body,
    } as MemoryHit,
    sim: cosineSimilarity(qEmb, float32FromBlob(r.embedding)),
  }));
  scored.sort((a, b) => b.sim - a.sim);

  let results = scored.slice(0, limit).map((s) => ({
    ...s.hit,
    ...(includeScores ? { score: Math.max(0, Math.min(1.0, s.sim)) } : {}),
  }));

  // Apply min_score filter when scores are requested.
  if (includeScores && minScore != null && minScore > 0) {
    results = results.filter((r) => (r.score ?? 0) >= minScore);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

interface SnippetOptions {
  /** Maximum character length of the snippet. */
  readonly maxChars: number;
  /** String to wrap matched terms with (e.g. "**"). Empty string disables highlighting. */
  readonly highlightTag: string;
}

/**
 * Extract the most relevant snippet from `body` for the given `query` terms.
 * Prefers sentence boundaries when possible. Highlights matched terms with `highlightTag`.
 */
export function extractSnippet(body: string, query: string, opts: SnippetOptions): string {
  const { maxChars, highlightTag } = opts;
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);

  if (terms.length === 0 || body.length === 0) {
    return applyHighlights(body.slice(0, maxChars), terms, highlightTag);
  }

  // For short documents, just return the whole body with highlights.
  if (body.length <= maxChars) {
    return applyHighlights(body, terms, highlightTag);
  }

  // Find the best window: the position that maximizes term density.
  const lowerBody = body.toLowerCase();
  const positions: number[] = [];
  for (const term of terms) {
    let idx = lowerBody.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = lowerBody.indexOf(term, idx + 1);
    }
  }

  if (positions.length === 0) {
    // No exact term matches — return the beginning of the body.
    const snippet = trimToSentenceBoundary(body, 0, maxChars);
    return applyHighlights(snippet, terms, highlightTag);
  }

  // Score each candidate start position by counting term occurrences in the window.
  positions.sort((a, b) => a - b);
  let bestStart = 0;
  let bestCount = 0;
  for (const pos of positions) {
    // Center the window around this position.
    const start = Math.max(0, pos - Math.floor(maxChars / 4));
    const window = lowerBody.slice(start, start + maxChars);
    let count = 0;
    for (const term of terms) {
      let si = window.indexOf(term);
      while (si !== -1) {
        count++;
        si = window.indexOf(term, si + 1);
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }

  const snippet = trimToSentenceBoundary(body, bestStart, maxChars);
  return applyHighlights(snippet, terms, highlightTag);
}

/** Try to expand/contract the window to align with sentence boundaries. */
function trimToSentenceBoundary(body: string, start: number, maxChars: number): string {
  let s = start;
  let e = Math.min(body.length, start + maxChars);

  // If not starting at the beginning, try to find a sentence start nearby.
  if (s > 0) {
    const sentenceBreak = /[.!?]\s+/g;
    const searchRegion = body.slice(Math.max(0, s - 60), s + 60);
    let best = -1;
    let m: RegExpExecArray | null;
    while ((m = sentenceBreak.exec(searchRegion)) !== null) {
      const absPos = Math.max(0, s - 60) + m.index + m[0].length;
      if (absPos <= s + 40) best = absPos;
    }
    if (best >= 0) {
      const shift = best - s;
      s = best;
      e = Math.min(body.length, e + shift);
    }
  }

  let raw = body.slice(s, e);

  // If we cut off the end, try to end at a sentence boundary.
  if (e < body.length) {
    const lastSentence = raw.search(/[.!?]\s+[^\s]*$/);
    if (lastSentence > maxChars * 0.4) {
      // Find the actual period/punctuation position.
      const endMatch = raw.slice(lastSentence).match(/^[.!?]/);
      if (endMatch) {
        raw = raw.slice(0, lastSentence + 1);
      }
    }
  }

  const prefix = s > 0 ? "…" : "";
  const suffix = s + maxChars < body.length && raw.length >= maxChars * 0.8 ? "…" : "";
  return `${prefix}${raw.trim()}${suffix}`;
}

/** Wrap occurrences of query terms with the highlight tag (case-insensitive). */
function applyHighlights(text: string, terms: string[], tag: string): string {
  if (!tag || terms.length === 0) return text;

  // Build a single regex matching any of the terms (longest first to avoid partial matches).
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return text.replace(re, `${tag}$1${tag}`);
}
