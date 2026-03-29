import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
import type Database from "better-sqlite3";

export interface MemoryHit {
  readonly id: number;
  readonly sourcePath: string;
  readonly title: string;
  readonly body: string;
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

/**
 * Scan absolute directory roots for `*.md`, upsert into `memory_documents` / FTS.
 * @returns count of rows inserted or updated (not skipped unchanged).
 */
export function ingestMemoryRoots(db: Database.Database, absoluteRoots: string[]): number {
  let changed = 0;
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

  const run = db.transaction((roots: string[]) => {
    for (const root of roots) {
      const realRoot = realpathSync(root);
      for (const filePath of walkMarkdownFiles(realRoot)) {
        const abs = realpathSync(filePath);
        const raw = readFileSync(abs, "utf8");
        const { title, body } = parseMarkdownForMemory(raw);
        const hash = sha256Hex(body);
        const st = statSync(abs);
        const mtimeMs = Math.trunc(st.mtimeMs);
        const row = select.get({ path: abs }) as { id: number; content_sha256: string } | undefined;
        if (row && row.content_sha256 === hash) continue;
        if (row) {
          update.run({
            id: row.id,
            title: title || null,
            body,
            hash,
            mtime: mtimeMs,
          });
        } else {
          insert.run({
            path: abs,
            title: title || null,
            body,
            hash,
            mtime: mtimeMs,
          });
        }
        changed += 1;
      }
    }
  });

  run(absoluteRoots);
  return changed;
}

export function searchMemoryFts(
  db: Database.Database,
  query: string,
  opts: { limit: number },
): MemoryHit[] {
  const fts = buildFtsQuery(query);
  if (!fts) return [];

  const stmt = db.prepare(`
    SELECT d.id AS id, d.source_path AS sourcePath, d.title AS title, d.body AS body
    FROM memory_fts
    JOIN memory_documents d ON d.id = memory_fts.rowid
    WHERE memory_fts MATCH @match
    ORDER BY bm25(memory_fts)
    LIMIT @lim
  `);

  const rows = stmt.all({ match: fts, lim: opts.limit }) as MemoryHit[];
  return rows.map((r) => ({
    id: r.id,
    sourcePath: r.sourcePath,
    title: r.title ?? "",
    body: r.body,
  }));
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
}

/**
 * When embeddings are enabled and a query vector + model id are provided and at least one
 * stored embedding exists for that model, rank by cosine similarity. Otherwise FTS (BM25).
 */
export function searchMemoryWithOptionalEmbedding(
  db: Database.Database,
  opts: SearchMemoryHybridOptions,
): MemoryHit[] {
  const { textQuery, limit } = opts;
  const modelId = opts.embeddingModelId ?? "default";
  const qEmb = opts.queryEmbedding;
  const embOn = opts.embeddingsEnabled === true && qEmb != null && qEmb.length > 0;
  const embHealthy = opts.embeddingsHealthy !== false;

  const countEmb = db
    .prepare("SELECT COUNT(*) AS c FROM memory_embeddings WHERE model_id = @m")
    .get({ m: modelId }) as { c: number };

  if (!embOn || countEmb.c === 0 || !embHealthy) {
    return searchMemoryFts(db, textQuery, { limit });
  }

  const rows = db
    .prepare(
      `
    SELECT d.id AS id, d.source_path AS sourcePath, d.title AS title, d.body AS body, e.embedding AS embedding
    FROM memory_embeddings e
    JOIN memory_documents d ON d.id = e.document_id
    WHERE e.model_id = @model
  `,
    )
    .all({ model: modelId }) as {
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
  return scored.slice(0, limit).map((s) => s.hit);
}
