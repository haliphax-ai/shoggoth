import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
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
  extractSnippet,
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

    const result = ingestMemoryRoots(db, [memRoot]);
    assert.equal(result.changed, 1);

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

    assert.equal(ingestMemoryRoots(db, [memRoot]).changed, 1);
    assert.equal(ingestMemoryRoots(db, [memRoot]).changed, 0);

    writeFileSync(f, "# T\n\nv2 uniquegamma\n", "utf8");
    assert.equal(ingestMemoryRoots(db, [memRoot]).changed, 1);

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

// ---------------------------------------------------------------------------
// Relevance scores
// ---------------------------------------------------------------------------

describe("memory — relevance scores", () => {
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

  it("searchMemoryFts returns scores when includeScores is true", () => {
    const memRoot = join(tmp, "scores");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "a.md"), "# A\n\nzeta once\n", "utf8");
    writeFileSync(join(memRoot, "b.md"), "# B\n\nzeta zeta zeta many\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const hits = searchMemoryFts(db, "zeta", { limit: 10, includeScores: true });
    assert.equal(hits.length, 2);
    assert.ok(typeof hits[0]!.score === "number", "score should be a number");
    assert.ok(typeof hits[1]!.score === "number", "score should be a number");
    assert.ok(hits[0]!.score! >= hits[1]!.score!, "first hit should have higher or equal score");
    assert.ok(hits[0]!.score! > 0 && hits[0]!.score! <= 1, "score should be in (0, 1]");
  });

  it("searchMemoryFts omits scores when includeScores is false", () => {
    const memRoot = join(tmp, "no-scores");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "a.md"), "# A\n\nomega test\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const hits = searchMemoryFts(db, "omega", { limit: 10, includeScores: false });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.score, undefined, "score should not be present");
  });

  it("searchMemoryFts filters by minScore", () => {
    const memRoot = join(tmp, "min-score");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "a.md"), "# A\n\nkappa once\n", "utf8");
    writeFileSync(join(memRoot, "b.md"), "# B\n\nkappa kappa kappa kappa kappa many\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const allHits = searchMemoryFts(db, "kappa", { limit: 10, includeScores: true, minScore: 0 });
    assert.equal(allHits.length, 2);

    // With a high minScore, only the best match should survive.
    const filtered = searchMemoryFts(db, "kappa", { limit: 10, includeScores: true, minScore: 0.99 });
    assert.ok(filtered.length <= 1, "high minScore should filter out weaker matches");
  });

  it("searchMemoryWithOptionalEmbedding returns cosine scores when includeScores is true", () => {
    const memRoot = join(tmp, "emb-scores");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "x.md"), "# X\n\napple fruit\n", "utf8");
    writeFileSync(join(memRoot, "y.md"), "# Y\n\nbanana boat\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const rowX = db.prepare("SELECT id FROM memory_documents WHERE source_path LIKE ?").get("%x.md") as { id: number };
    const rowY = db.prepare("SELECT id FROM memory_documents WHERE source_path LIKE ?").get("%y.md") as { id: number };

    upsertMemoryEmbedding(db, rowX.id, "m1", new Float32Array([0.9, 0.1, 0]));
    upsertMemoryEmbedding(db, rowY.id, "m1", new Float32Array([0, 0.9, 0.1]));

    const hits = searchMemoryWithOptionalEmbedding(db, {
      textQuery: "fruit",
      queryEmbedding: new Float32Array([1, 0, 0]),
      embeddingModelId: "m1",
      limit: 5,
      embeddingsEnabled: true,
      includeScores: true,
    });
    assert.ok(hits.length >= 1);
    assert.ok(typeof hits[0]!.score === "number");
    assert.ok(hits[0]!.score! > 0, "cosine score should be positive for similar vectors");
  });
});

// ---------------------------------------------------------------------------
// Path prefix and date range filters
// ---------------------------------------------------------------------------

describe("memory — search filters", () => {
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

  it("searchMemoryFts filters by path prefix", () => {
    const memRoot = join(tmp, "prefix");
    mkdirSync(join(memRoot, "projects", "alpha"), { recursive: true });
    mkdirSync(join(memRoot, "projects", "beta"), { recursive: true });
    writeFileSync(join(memRoot, "projects", "alpha", "a.md"), "# A\n\nuniquefoo data\n", "utf8");
    writeFileSync(join(memRoot, "projects", "beta", "b.md"), "# B\n\nuniquefoo data\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const alphaPrefix = join(memRoot, "projects", "alpha");
    const hits = searchMemoryFts(db, "uniquefoo", {
      limit: 10,
      filters: { pathPrefix: alphaPrefix },
    });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.sourcePath, /alpha/);
  });

  it("searchMemoryFts filters by path prefix with trailing slash", () => {
    const memRoot = join(tmp, "prefix-slash");
    mkdirSync(join(memRoot, "notes"), { recursive: true });
    writeFileSync(join(memRoot, "notes", "n.md"), "# N\n\nuniquebarx content\n", "utf8");
    writeFileSync(join(memRoot, "top.md"), "# T\n\nuniquebarx content\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const hits = searchMemoryFts(db, "uniquebarx", {
      limit: 10,
      filters: { pathPrefix: join(memRoot, "notes") + "/" },
    });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.sourcePath, /notes/);
  });

  it("searchMemoryFts filters by date range (afterMs)", () => {
    const memRoot = join(tmp, "date");
    mkdirSync(memRoot, { recursive: true });
    const f = join(memRoot, "dated.md");
    writeFileSync(f, "# D\n\nuniquedate content\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    // Get the actual mtime from the DB.
    const row = db.prepare("SELECT source_mtime_ms FROM memory_documents LIMIT 1").get() as { source_mtime_ms: number };
    const mtime = row.source_mtime_ms;

    // afterMs = mtime + 1 should exclude the document.
    const noHits = searchMemoryFts(db, "uniquedate", {
      limit: 10,
      filters: { afterMs: mtime + 1 },
    });
    assert.equal(noHits.length, 0);

    // afterMs = mtime should include the document (>= comparison).
    const hits = searchMemoryFts(db, "uniquedate", {
      limit: 10,
      filters: { afterMs: mtime },
    });
    assert.equal(hits.length, 1);
  });

  it("searchMemoryFts filters by date range (beforeMs)", () => {
    const memRoot = join(tmp, "datebefore");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "old.md"), "# O\n\nuniquebefore content\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const row = db.prepare("SELECT source_mtime_ms FROM memory_documents LIMIT 1").get() as { source_mtime_ms: number };
    const mtime = row.source_mtime_ms;

    // beforeMs = mtime should exclude (strict <).
    const noHits = searchMemoryFts(db, "uniquebefore", {
      limit: 10,
      filters: { beforeMs: mtime },
    });
    assert.equal(noHits.length, 0);

    // beforeMs = mtime + 1 should include.
    const hits = searchMemoryFts(db, "uniquebefore", {
      limit: 10,
      filters: { beforeMs: mtime + 1 },
    });
    assert.equal(hits.length, 1);
  });

  it("searchMemoryWithOptionalEmbedding applies path prefix filter to vector search", () => {
    const memRoot = join(tmp, "emb-prefix");
    mkdirSync(join(memRoot, "proj"), { recursive: true });
    mkdirSync(join(memRoot, "other"), { recursive: true });
    writeFileSync(join(memRoot, "proj", "x.md"), "# X\n\napple fruit\n", "utf8");
    writeFileSync(join(memRoot, "other", "y.md"), "# Y\n\nbanana boat\n", "utf8");
    ingestMemoryRoots(db, [memRoot]);

    const rowX = db.prepare("SELECT id FROM memory_documents WHERE source_path LIKE ?").get("%proj%x.md") as { id: number };
    const rowY = db.prepare("SELECT id FROM memory_documents WHERE source_path LIKE ?").get("%other%y.md") as { id: number };

    upsertMemoryEmbedding(db, rowX.id, "m1", new Float32Array([0.9, 0.1, 0]));
    upsertMemoryEmbedding(db, rowY.id, "m1", new Float32Array([0.8, 0.2, 0]));

    const hits = searchMemoryWithOptionalEmbedding(db, {
      textQuery: "fruit",
      queryEmbedding: new Float32Array([1, 0, 0]),
      embeddingModelId: "m1",
      limit: 10,
      embeddingsEnabled: true,
      filters: { pathPrefix: join(memRoot, "proj") },
    });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.sourcePath, /proj/);
  });
});

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

describe("memory — extractSnippet", () => {
  it("returns full body with highlights for short documents", () => {
    const result = extractSnippet("apple banana cherry", "banana", {
      maxChars: 200,
      highlightTag: "**",
    });
    assert.ok(result.includes("**banana**"), `expected highlighted term, got: ${result}`);
    assert.ok(result.includes("apple"), "should include surrounding text");
  });

  it("returns snippet around matched term for long documents", () => {
    const filler = "Lorem ipsum dolor sit amet. ".repeat(20);
    const body = `${filler}The rollback procedure requires running migrate. ${filler}`;
    const result = extractSnippet(body, "rollback", {
      maxChars: 100,
      highlightTag: "**",
    });
    assert.ok(result.includes("**rollback**"), `expected highlighted term, got: ${result}`);
    assert.ok(result.length <= 150, "snippet should be roughly within maxChars (with ellipsis/highlights)");
  });

  it("disables highlighting when highlightTag is empty", () => {
    const result = extractSnippet("apple banana cherry", "banana", {
      maxChars: 200,
      highlightTag: "",
    });
    assert.ok(!result.includes("**"), "should not contain highlight markers");
    assert.ok(result.includes("banana"), "should still contain the term");
  });

  it("handles no matching terms gracefully", () => {
    const result = extractSnippet("apple banana cherry", "zebra", {
      maxChars: 200,
      highlightTag: "**",
    });
    // Should return beginning of body.
    assert.ok(result.includes("apple"), "should return start of body when no match");
  });

  it("handles empty body", () => {
    const result = extractSnippet("", "test", { maxChars: 200, highlightTag: "**" });
    assert.equal(result, "");
  });

  it("handles empty query", () => {
    const result = extractSnippet("some content", "", { maxChars: 200, highlightTag: "**" });
    assert.ok(result.includes("some content"));
  });

  it("highlights multiple terms", () => {
    const result = extractSnippet("apple banana cherry date elderberry", "apple cherry", {
      maxChars: 200,
      highlightTag: "**",
    });
    assert.ok(result.includes("**apple**"), "should highlight first term");
    assert.ok(result.includes("**cherry**"), "should highlight second term");
  });

  it("uses custom highlight tag", () => {
    const result = extractSnippet("apple banana cherry", "banana", {
      maxChars: 200,
      highlightTag: "==",
    });
    assert.ok(result.includes("==banana=="), `expected custom tag, got: ${result}`);
  });
});

// ---------------------------------------------------------------------------
// Ingest — detailed file reporting
// ---------------------------------------------------------------------------

describe("memory — ingest file reporting", () => {
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

  it("reports added files with status 'added'", () => {
    const memRoot = join(tmp, "report-add");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "new.md"), "# New\n\nnew content\n", "utf8");

    const result = ingestMemoryRoots(db, [memRoot]);
    assert.equal(result.changed, 1);
    assert.equal(result.files.length, 1);
    assert.match(result.files[0]!.path, /new\.md$/);
    assert.equal(result.files[0]!.status, "added");
  });

  it("reports updated files with status 'updated'", () => {
    const memRoot = join(tmp, "report-upd");
    mkdirSync(memRoot, { recursive: true });
    const f = join(memRoot, "doc.md");
    writeFileSync(f, "# Doc\n\nv1\n", "utf8");

    ingestMemoryRoots(db, [memRoot]);
    writeFileSync(f, "# Doc\n\nv2 changed\n", "utf8");

    const result = ingestMemoryRoots(db, [memRoot]);
    assert.equal(result.changed, 1);
    assert.equal(result.files.length, 1);
    assert.match(result.files[0]!.path, /doc\.md$/);
    assert.equal(result.files[0]!.status, "updated");
  });

  it("reports removed files with status 'removed'", () => {
    const memRoot = join(tmp, "report-rm");
    mkdirSync(memRoot, { recursive: true });
    const f = join(memRoot, "gone.md");
    writeFileSync(f, "# Gone\n\nwill be deleted\n", "utf8");

    ingestMemoryRoots(db, [memRoot]);
    unlinkSync(f);

    const result = ingestMemoryRoots(db, [memRoot]);
    assert.equal(result.changed, 1);
    assert.equal(result.files.length, 1);
    assert.match(result.files[0]!.path, /gone\.md$/);
    assert.equal(result.files[0]!.status, "removed");
  });

  it("returns empty files array when nothing changed", () => {
    const memRoot = join(tmp, "report-noop");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "stable.md"), "# Stable\n\nunchanged\n", "utf8");

    ingestMemoryRoots(db, [memRoot]);
    const result = ingestMemoryRoots(db, [memRoot]);
    assert.equal(result.changed, 0);
    assert.deepEqual(result.files, []);
  });

  it("reports mixed add/update/remove in a single ingest", () => {
    const memRoot = join(tmp, "report-mix");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "keep.md"), "# Keep\n\nv1\n", "utf8");
    writeFileSync(join(memRoot, "remove.md"), "# Remove\n\nwill go\n", "utf8");

    ingestMemoryRoots(db, [memRoot]);

    // Modify one, delete one, add one.
    writeFileSync(join(memRoot, "keep.md"), "# Keep\n\nv2 updated\n", "utf8");
    unlinkSync(join(memRoot, "remove.md"));
    writeFileSync(join(memRoot, "brand-new.md"), "# New\n\nfresh\n", "utf8");

    const result = ingestMemoryRoots(db, [memRoot]);
    assert.equal(result.changed, 3);

    const statuses = new Map(result.files.map((f) => [f.status, f]));
    assert.ok(statuses.has("added"), "should have an added file");
    assert.ok(statuses.has("updated"), "should have an updated file");
    assert.ok(statuses.has("removed"), "should have a removed file");
  });
});

// ---------------------------------------------------------------------------
// Ingest — selective by path / glob
// ---------------------------------------------------------------------------

describe("memory — selective ingest (paths / exclude)", () => {
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

  it("paths filter restricts ingest to matching files only", () => {
    const memRoot = join(tmp, "sel-paths");
    mkdirSync(join(memRoot, "src"), { recursive: true });
    mkdirSync(join(memRoot, "docs"), { recursive: true });
    writeFileSync(join(memRoot, "src", "a.md"), "# A\n\nsrc file\n", "utf8");
    writeFileSync(join(memRoot, "docs", "b.md"), "# B\n\ndocs file\n", "utf8");

    const result = ingestMemoryRoots(db, [memRoot], { paths: ["src/**"] });
    assert.equal(result.changed, 1);
    assert.match(result.files[0]!.path, /src/);
    assert.equal(result.files[0]!.status, "added");

    // docs/b.md should not be in the index.
    const rows = db.prepare("SELECT source_path FROM memory_documents").all() as { source_path: string }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.source_path, /src/);
  });

  it("exclude filter skips matching files", () => {
    const memRoot = join(tmp, "sel-excl");
    mkdirSync(join(memRoot, "src"), { recursive: true });
    writeFileSync(join(memRoot, "src", "code.md"), "# Code\n\ncode file\n", "utf8");
    writeFileSync(join(memRoot, "src", "code.test.md"), "# Test\n\ntest file\n", "utf8");

    const result = ingestMemoryRoots(db, [memRoot], { exclude: ["**/*.test.md"] });
    assert.equal(result.changed, 1);
    assert.match(result.files[0]!.path, /code\.md$/);
  });

  it("paths and exclude compose correctly", () => {
    const memRoot = join(tmp, "sel-compose");
    mkdirSync(join(memRoot, "src", "utils"), { recursive: true });
    mkdirSync(join(memRoot, "docs"), { recursive: true });
    writeFileSync(join(memRoot, "src", "main.md"), "# Main\n\nmain\n", "utf8");
    writeFileSync(join(memRoot, "src", "utils", "helper.md"), "# Helper\n\nhelper\n", "utf8");
    writeFileSync(join(memRoot, "src", "utils", "helper.test.md"), "# HTest\n\ntest\n", "utf8");
    writeFileSync(join(memRoot, "docs", "readme.md"), "# Readme\n\nreadme\n", "utf8");

    const result = ingestMemoryRoots(db, [memRoot], {
      paths: ["src/**"],
      exclude: ["**/*.test.md"],
    });
    assert.equal(result.changed, 2);
    const paths = result.files.map((f) => f.path);
    assert.ok(paths.some((p) => p.includes("main.md")), "should include main.md");
    assert.ok(paths.some((p) => p.includes("helper.md")), "should include helper.md");
    assert.ok(!paths.some((p) => p.includes("test")), "should not include test files");
    assert.ok(!paths.some((p) => p.includes("docs")), "should not include docs");
  });

  it("exclude without paths applies to full ingest", () => {
    const memRoot = join(tmp, "sel-excl-full");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "keep.md"), "# Keep\n\nkeep\n", "utf8");
    writeFileSync(join(memRoot, "skip.test.md"), "# Skip\n\nskip\n", "utf8");

    const result = ingestMemoryRoots(db, [memRoot], { exclude: ["*.test.md"] });
    assert.equal(result.changed, 1);
    assert.match(result.files[0]!.path, /keep\.md$/);
  });

  it("empty paths match returns zero changes and empty files", () => {
    const memRoot = join(tmp, "sel-empty");
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(join(memRoot, "a.md"), "# A\n\ncontent\n", "utf8");

    const result = ingestMemoryRoots(db, [memRoot], { paths: ["nonexistent/**"] });
    assert.equal(result.changed, 0);
    assert.deepEqual(result.files, []);
  });

  it("scoped ingest does not remove index entries outside the scope", () => {
    const memRoot = join(tmp, "sel-no-rm");
    mkdirSync(join(memRoot, "src"), { recursive: true });
    mkdirSync(join(memRoot, "docs"), { recursive: true });
    writeFileSync(join(memRoot, "src", "a.md"), "# A\n\nsrc\n", "utf8");
    writeFileSync(join(memRoot, "docs", "b.md"), "# B\n\ndocs\n", "utf8");

    // Full ingest first — both files indexed.
    ingestMemoryRoots(db, [memRoot]);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_documents").get() as { c: number }).c,
      2,
    );

    // Delete docs/b.md from disk, then do a scoped ingest on src/ only.
    unlinkSync(join(memRoot, "docs", "b.md"));
    const result = ingestMemoryRoots(db, [memRoot], { paths: ["src/**"] });
    assert.equal(result.changed, 0, "src/a.md is unchanged");

    // docs/b.md should still be in the index (scoped ingest doesn't touch it).
    const count = (db.prepare("SELECT COUNT(*) AS c FROM memory_documents").get() as { c: number }).c;
    assert.equal(count, 2, "scoped ingest should not remove out-of-scope entries");
  });

  it("scoped ingest detects removed files within scope", () => {
    const memRoot = join(tmp, "sel-rm-scope");
    mkdirSync(join(memRoot, "src"), { recursive: true });
    writeFileSync(join(memRoot, "src", "a.md"), "# A\n\nwill be removed\n", "utf8");
    writeFileSync(join(memRoot, "src", "b.md"), "# B\n\nstays\n", "utf8");

    ingestMemoryRoots(db, [memRoot]);
    unlinkSync(join(memRoot, "src", "a.md"));

    const result = ingestMemoryRoots(db, [memRoot], { paths: ["src/**"] });
    assert.equal(result.changed, 1);
    assert.equal(result.files[0]!.status, "removed");
    assert.match(result.files[0]!.path, /a\.md$/);
  });
});
