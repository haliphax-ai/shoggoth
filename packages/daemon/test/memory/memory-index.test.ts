import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import {
  ingestMemoryRoots,
  searchMemoryFts,
  searchMemoryWithOptionalEmbedding,
  upsertMemoryEmbedding,
} from "../../src/memory/memory-index";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-mem-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("memory — markdown ingest + FTS/BM25", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ingestMemoryRoots indexes markdown under roots and searchMemoryFts finds terms", () => {
    const memRoot = join(tmp, "memory");
    mkdirSync(join(memRoot, "notes"), { recursive: true });
    writeFileSync(
      join(memRoot, "notes", "alpha.md"),
      "# Alpha title\n\nUnique keyword one for search.\n",
      "utf8",
    );

    const n = ingestMemoryRoots(db, [memRoot]);
    assert.equal(n, 1);

    const hits = searchMemoryFts(db, "Unique keyword", { limit: 10 });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.sourcePath, /alpha\.md$/);
    assert.equal(hits[0]!.title, "Alpha title");
    assert.ok(hits[0]!.body.includes("Unique keyword"));
  });

  it("re-ingest skips unchanged files and updates when content changes", () => {
    const memRoot = join(tmp, "m");
    mkdirSync(memRoot, { recursive: true });
    const f = join(memRoot, "doc.md");
    writeFileSync(f, "# T\n\nv1\n", "utf8");

    assert.equal(ingestMemoryRoots(db, [memRoot]), 1);
    assert.equal(ingestMemoryRoots(db, [memRoot]), 0);

    writeFileSync(f, "# T\n\nv2 uniquegamma\n", "utf8");
    assert.equal(ingestMemoryRoots(db, [memRoot]), 1);

    const hits = searchMemoryFts(db, "uniquegamma", { limit: 5 });
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.body.includes("v2"));
  });

  it("searchMemoryFts ranks more relevant doc higher (BM25)", () => {
    const memRoot = join(tmp, "rank");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(
      join(memRoot, "a.md"),
      "# A\n\nThe word zeta appears once.\n",
      "utf8",
    );
    writeFileSync(
      join(memRoot, "b.md"),
      "# B\n\nZeta zeta zeta zeta zeta many zeta terms.\n",
      "utf8",
    );
    ingestMemoryRoots(db, [memRoot]);

    const hits = searchMemoryFts(db, "zeta", { limit: 10 });
    assert.equal(hits.length, 2);
    assert.match(hits[0]!.sourcePath, /b\.md$/);
  });

  it("searchMemoryFts returns empty for blank query", () => {
    assert.deepEqual(searchMemoryFts(db, "   ", { limit: 5 }), []);
  });
});

describe("memory — optional embeddings", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsertMemoryEmbedding stores vector; search uses cosine when enabled", () => {
    const memRoot = join(tmp, "emb");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "x.md"), "# X\n\napple fruit\n", "utf8");
    writeFileSync(join(memRoot, "y.md"), "# Y\n\nbanana boat\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const rowX = db
      .prepare("SELECT id FROM memory_documents WHERE source_path LIKE ?")
      .get("%x.md") as { id: number };
    const rowY = db
      .prepare("SELECT id FROM memory_documents WHERE source_path LIKE ?")
      .get("%y.md") as { id: number };

    const q = new Float32Array([1, 0, 0]);
    const vx = new Float32Array([0.9, 0.1, 0]);
    const vy = new Float32Array([0, 0.9, 0.1]);
    upsertMemoryEmbedding(db, rowX.id, "m1", vx);
    upsertMemoryEmbedding(db, rowY.id, "m1", vy);

    const fts = searchMemoryWithOptionalEmbedding(db, {
      textQuery: "fruit",
      limit: 5,
      embeddingsEnabled: false,
    });
    assert.ok(fts.some((h) => h.sourcePath.includes("x.md")));

    const vec = searchMemoryWithOptionalEmbedding(db, {
      textQuery: "fruit",
      queryEmbedding: q,
      embeddingModelId: "m1",
      limit: 5,
      embeddingsEnabled: true,
    });
    assert.ok(vec.length >= 1);
    assert.match(vec[0]!.sourcePath, /x\.md$/);
  });

  it("searchMemoryWithOptionalEmbedding falls back to BM25 when embeddings unhealthy", () => {
    const memRoot = join(tmp, "unhealthy");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "p.md"), "# P\n\npineapple\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const row = db.prepare("SELECT id FROM memory_documents LIMIT 1").get() as { id: number };
    upsertMemoryEmbedding(db, row.id, "m1", new Float32Array([1, 0, 0]));

    const hits = searchMemoryWithOptionalEmbedding(db, {
      textQuery: "pineapple",
      queryEmbedding: new Float32Array([0, 1, 0]),
      embeddingModelId: "m1",
      limit: 5,
      embeddingsEnabled: true,
      embeddingsHealthy: false,
    });
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.body.includes("pineapple"));
  });

  it("searchMemoryWithOptionalEmbedding falls back to BM25 when embeddings enabled but no vectors stored", () => {
    const memRoot = join(tmp, "fb");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "only.md"), "# O\n\ndelta wave\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const hits = searchMemoryWithOptionalEmbedding(db, {
      textQuery: "delta",
      queryEmbedding: new Float32Array([1, 0, 0]),
      embeddingModelId: "m1",
      limit: 5,
      embeddingsEnabled: true,
    });
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.sourcePath.includes("only.md"));
  });
});
