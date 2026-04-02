import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { resolveMemoryScanRoots, runMemoryBuiltin } from "../../src/memory/builtin-memory-tools";
import type { FetchLike } from "@shoggoth/models";

describe("builtin memory tools", () => {
  it("resolveMemoryScanRoots resolves relative paths under workspace", () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-mem-ws-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    const roots = resolveMemoryScanRoots(ws, ["memory"]);
    assert.deepEqual(roots, [mem]);
  });

  it("ingest then search returns hits with truncated bodies", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-mem-ws-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "note.md"), "# Alpha\n\nuniquebeta keywordgamma\n");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };

    const ing = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db,
      workspacePath: ws,
      memory,
      env: { ...process.env },
    });
    const ingParsed = JSON.parse(ing.resultJson) as { changed: number; rootsScanned: number };
    assert.ok(ingParsed.changed >= 1);
    assert.equal(ingParsed.rootsScanned, 1);

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "uniquebeta", limit: 5 }),
      db,
      workspacePath: ws,
      memory,
      env: { ...process.env },
    });
    const searchParsed = JSON.parse(sr.resultJson) as {
      query: string;
      hits: { title: string; body: string; sourcePath: string }[];
    };
    assert.equal(searchParsed.hits.length, 1);
    assert.match(searchParsed.hits[0]!.body, /uniquebeta/);

    db.close();
  });

  it("memory.search with empty memory.paths returns guidance", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    const out = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "x" }),
      db,
      workspacePath: "/tmp",
      memory: { paths: [], embeddings: { enabled: false } },
      env: { ...process.env },
    });
    const j = JSON.parse(out.resultJson) as { hits: unknown[]; message?: string };
    assert.equal(j.hits.length, 0);
    assert.ok(j.message?.includes("memory.paths"));
    db.close();
  });

  it("memory.search uses query embedding when enabled and API succeeds (vector rank)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-mem-emb-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "apples.md"), "# Apples\n\nred round fruit alpha\n", "utf8");
    writeFileSync(join(mem, "boats.md"), "# Boats\n\nsailing vessel beta\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = {
      paths: ["memory"],
      embeddings: { enabled: true, modelId: "emb-test-model" },
    };

    let embeddingPosts = 0;
    const mockFetch: FetchLike = async (url, init) => {
      const u = String(url);
      if (u.includes("/embeddings") && init?.method === "POST") {
        embeddingPosts += 1;
        const body = init.body != null ? JSON.parse(String(init.body)) : {};
        const inp = String((body as { input?: string }).input ?? "");
        // Query embedding biased toward "apple" dimension
        const vec =
          inp.includes("alpha") || inp.includes("fruit")
            ? [1, 0, 0]
            : [0, 1, 0];
        return new Response(
          JSON.stringify({
            data: [{ embedding: vec, index: 0, object: "embedding" }],
            model: "emb-test-model",
            object: "list",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db,
      workspacePath: ws,
      memory,
      env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.example.com/v1" },
      fetchImpl: mockFetch,
    });
    assert.ok(embeddingPosts >= 1, "ingest should request embeddings for documents");

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "fruit alpha", limit: 5 }),
      db,
      workspacePath: ws,
      memory,
      env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.example.com/v1" },
      fetchImpl: mockFetch,
    });
    const searchParsed = JSON.parse(sr.resultJson) as {
      hits: { sourcePath: string }[];
    };
    assert.equal(searchParsed.hits.length, 2);
    assert.match(searchParsed.hits[0]!.sourcePath, /apples\.md$/);

    db.close();
  });

  it("memory.search falls back to FTS when embeddings enabled but no vectors stored (e.g. ingest embed failed)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-mem-no-vec-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "lime.md"), "# L\n\nlime citrus uniqueq\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = {
      paths: ["memory"],
      embeddings: { enabled: true, modelId: "m-nov" },
    };

    await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db,
      workspacePath: ws,
      memory,
      env: { OPENAI_API_KEY: "k" },
      fetchImpl: async () => new Response("no embed", { status: 500 }),
    });

    let searchPosts = 0;
    const mockFetch: FetchLike = async (url, init) => {
      if (String(url).includes("/embeddings") && init?.method === "POST") {
        searchPosts += 1;
        return new Response(
          JSON.stringify({
            data: [{ embedding: [1, 0, 0], index: 0, object: "embedding" }],
            object: "list",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("no", { status: 404 });
    };

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "uniqueq", limit: 5 }),
      db,
      workspacePath: ws,
      memory,
      env: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://api.example.com/v1" },
      fetchImpl: mockFetch,
    });
    assert.equal(searchPosts, 1, "search still requests query embedding when enabled");
    const j = JSON.parse(sr.resultJson) as { hits: { body: string }[] };
    assert.equal(j.hits.length, 1);
    assert.match(j.hits[0]!.body, /uniqueq/);
    db.close();
  });

  it("memory.search falls back to FTS when embedding API fails", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-mem-emb-fail-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "pine.md"), "# P\n\npineapple uniquexyz\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = {
      paths: ["memory"],
      embeddings: { enabled: true, modelId: "m1" },
    };

    await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db,
      workspacePath: ws,
      memory,
      env: { OPENAI_API_KEY: "k" },
      fetchImpl: async () => new Response("bad", { status: 500 }),
    });

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "uniquexyz", limit: 5 }),
      db,
      workspacePath: ws,
      memory,
      env: { OPENAI_API_KEY: "k" },
      fetchImpl: async () => new Response("bad", { status: 500 }),
    });
    const j = JSON.parse(sr.resultJson) as { hits: { body: string }[] };
    assert.equal(j.hits.length, 1);
    assert.match(j.hits[0]!.body, /uniquexyz/);
    db.close();
  });

  it("memory.ingest skips embedding API when content_sha256 unchanged", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-mem-skip-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    const f = join(mem, "doc.md");
    writeFileSync(f, "# T\n\nstable body gamma\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = {
      paths: ["memory"],
      embeddings: { enabled: true, modelId: "m-embed" },
    };

    let posts = 0;
    const mockFetch: FetchLike = async (url, init) => {
      if (String(url).includes("/embeddings")) {
        posts += 1;
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2], index: 0, object: "embedding" }],
            object: "list",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("no", { status: 404 });
    };

    const env = { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://api.openai.com/v1" };

    await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db,
      workspacePath: ws,
      memory,
      env,
      fetchImpl: mockFetch,
    });
    const firstPosts = posts;

    await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db,
      workspacePath: ws,
      memory,
      env,
      fetchImpl: mockFetch,
    });
    assert.equal(posts, firstPosts, "second ingest should not call embeddings API for unchanged body");

    writeFileSync(f, "# T\n\nstable body gamma delta\n", "utf8");
    await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db,
      workspacePath: ws,
      memory,
      env,
      fetchImpl: mockFetch,
    });
    assert.ok(posts > firstPosts, "content change should trigger a new embedding request");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// memory.search — new parameters (scores, filters, snippets)
// ---------------------------------------------------------------------------

describe("memory.search — relevance scores", () => {
  it("returns scores when include_scores is true", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-scores-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "a.md"), "# A\n\nscoreword once\n", "utf8");
    writeFileSync(join(mem, "b.md"), "# B\n\nscoreword scoreword scoreword many\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "scoreword", include_scores: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: { score: number }[] };
    assert.equal(j.hits.length, 2);
    assert.ok(typeof j.hits[0]!.score === "number", "score should be present");
    assert.ok(typeof j.hits[1]!.score === "number", "score should be present");
    db.close();
  });

  it("does not return scores when include_scores is omitted (backward compat)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-no-scores-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "a.md"), "# A\n\nnoscorekw data\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "noscorekw" }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: { score?: number; body: string }[] };
    assert.equal(j.hits.length, 1);
    assert.equal(j.hits[0]!.score, undefined, "score should not be present by default");
    assert.ok(j.hits[0]!.body, "body should still be present");
    db.close();
  });

  it("filters results by min_score", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-minscore-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "a.md"), "# A\n\nfilterword once\n", "utf8");
    writeFileSync(join(mem, "b.md"), "# B\n\nfilterword filterword filterword filterword many\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "filterword", include_scores: true, min_score: 0.99 }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: { score: number }[] };
    assert.ok(j.hits.length <= 1, "high min_score should filter weaker matches");
    db.close();
  });
});

describe("memory.search — path prefix filter", () => {
  it("filters results by path_prefix", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-pathpfx-"));
    const mem = join(ws, "memory");
    mkdirSync(join(mem, "alpha"), { recursive: true });
    mkdirSync(join(mem, "beta"), { recursive: true });
    writeFileSync(join(mem, "alpha", "a.md"), "# A\n\npathkeyword data\n", "utf8");
    writeFileSync(join(mem, "beta", "b.md"), "# B\n\npathkeyword data\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    // Use the absolute path as path_prefix since source_path is absolute after ingest.
    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "pathkeyword", path_prefix: join(mem, "alpha") }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: { sourcePath: string }[] };
    assert.equal(j.hits.length, 1);
    assert.match(j.hits[0]!.sourcePath, /alpha/);
    db.close();
  });
});

describe("memory.search — date range filters", () => {
  it("filters by after date", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-after-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "doc.md"), "# D\n\ndatekw content\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    // Future date should exclude everything.
    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "datekw", after: "2099-01-01T00:00:00Z" }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: unknown[] };
    assert.equal(j.hits.length, 0);

    // Past date should include everything.
    const sr2 = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "datekw", after: "2000-01-01T00:00:00Z" }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j2 = JSON.parse(sr2.resultJson) as { hits: unknown[] };
    assert.equal(j2.hits.length, 1);
    db.close();
  });

  it("filters by before date", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-before-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "doc.md"), "# D\n\nbeforekw content\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    // Past date should exclude everything.
    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "beforekw", before: "2000-01-01T00:00:00Z" }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: unknown[] };
    assert.equal(j.hits.length, 0);

    // Future date should include everything.
    const sr2 = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "beforekw", before: "2099-01-01T00:00:00Z" }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j2 = JSON.parse(sr2.resultJson) as { hits: unknown[] };
    assert.equal(j2.hits.length, 1);
    db.close();
  });

  it("returns error when after >= before", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "test", after: "2026-06-01T00:00:00Z", before: "2026-01-01T00:00:00Z" }),
      db, workspacePath: "/tmp",
      memory: { paths: ["memory"], embeddings: { enabled: false } },
      env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { error: string };
    assert.ok(j.error.includes("earlier"), `expected validation error, got: ${j.error}`);
    db.close();
  });

  it("returns error for invalid ISO date", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "test", after: "not-a-date" }),
      db, workspacePath: "/tmp",
      memory: { paths: ["memory"], embeddings: { enabled: false } },
      env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { error: string };
    assert.ok(j.error.includes("invalid"), `expected date parse error, got: ${j.error}`);
    db.close();
  });
});

describe("memory.search — snippet mode", () => {
  it("returns snippet and omits body when snippet=true", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-snippet-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    const longBody = "# Doc\n\n" + "filler text here. ".repeat(50) + "The rollback procedure is important. " + "more filler. ".repeat(50);
    writeFileSync(join(mem, "doc.md"), longBody, "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "rollback", snippet: true, snippet_chars: 100 }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: { snippet?: string; body?: string }[] };
    assert.equal(j.hits.length, 1);
    assert.ok(j.hits[0]!.snippet, "snippet should be present");
    assert.ok(j.hits[0]!.snippet!.includes("**rollback**"), "snippet should highlight matched term");
    assert.equal(j.hits[0]!.body, undefined, "body should be omitted in snippet mode");
    db.close();
  });

  it("returns both snippet and body when snippet=true and include_body=true", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-snip-body-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "doc.md"), "# Doc\n\nshort rollback note\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "rollback", snippet: true, include_body: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: { snippet?: string; body?: string }[] };
    assert.equal(j.hits.length, 1);
    assert.ok(j.hits[0]!.snippet, "snippet should be present");
    assert.ok(j.hits[0]!.body, "body should also be present when include_body=true");
    db.close();
  });

  it("uses custom highlight_tag", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-snip-tag-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "doc.md"), "# Doc\n\ncustom highlight test\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "highlight", snippet: true, highlight_tag: "==" }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: { snippet?: string }[] };
    assert.equal(j.hits.length, 1);
    assert.ok(j.hits[0]!.snippet!.includes("==highlight=="), `expected custom tag, got: ${j.hits[0]!.snippet}`);
    db.close();
  });

  it("disables highlighting when highlight_tag is empty", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-snip-notag-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "doc.md"), "# Doc\n\nnohighlight test\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({ originalName: "memory.ingest", argsJson: "{}", db, workspacePath: ws, memory, env: { ...process.env } });

    const sr = await runMemoryBuiltin({
      originalName: "memory.search",
      argsJson: JSON.stringify({ query: "nohighlight", snippet: true, highlight_tag: "" }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(sr.resultJson) as { hits: { snippet?: string }[] };
    assert.equal(j.hits.length, 1);
    assert.ok(j.hits[0]!.snippet!.includes("nohighlight"), "term should be present");
    assert.ok(!j.hits[0]!.snippet!.includes("**"), "should not contain default highlight markers");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// memory.ingest — report parameter
// ---------------------------------------------------------------------------

describe("memory.ingest — report parameter", () => {
  it("returns file details when report=true", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-report-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "a.md"), "# A\n\nalpha content\n", "utf8");
    writeFileSync(join(mem, "b.md"), "# B\n\nbeta content\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    const result = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: JSON.stringify({ report: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(result.resultJson) as {
      changed: number;
      rootsScanned: number;
      files?: { path: string; status: string }[];
    };
    assert.equal(j.changed, 2);
    assert.equal(j.rootsScanned, 1);
    assert.ok(Array.isArray(j.files), "files array should be present when report=true");
    assert.equal(j.files!.length, 2);
    assert.ok(j.files!.every((f) => f.status === "added"), "all files should be 'added'");
    db.close();
  });

  it("does not return files when report is omitted (backward compat)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-no-report-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "a.md"), "# A\n\ncontent\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    const result = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(result.resultJson) as { changed: number; files?: unknown };
    assert.equal(j.changed, 1);
    assert.equal(j.files, undefined, "files should not be present when report is not requested");
    db.close();
  });

  it("reports removed files when report=true", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-report-rm-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    const f = join(mem, "gone.md");
    writeFileSync(f, "# Gone\n\nwill be deleted\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };

    // First ingest to populate the index.
    await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db, workspacePath: ws, memory, env: { ...process.env },
    });

    // Delete the file and re-ingest with report.
    unlinkSync(f);
    const result = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: JSON.stringify({ report: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(result.resultJson) as {
      changed: number;
      files?: { path: string; status: string }[];
    };
    assert.equal(j.changed, 1);
    assert.equal(j.files!.length, 1);
    assert.equal(j.files![0]!.status, "removed");
    db.close();
  });

  it("returns empty files array on no-op ingest with report=true", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-report-noop-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "stable.md"), "# S\n\nstable\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: "{}",
      db, workspacePath: ws, memory, env: { ...process.env },
    });

    const result = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: JSON.stringify({ report: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(result.resultJson) as { changed: number; files?: unknown[] };
    assert.equal(j.changed, 0);
    assert.ok(Array.isArray(j.files), "files should be an empty array, not omitted");
    assert.equal(j.files!.length, 0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// memory.ingest — selective ingest (paths / exclude)
// ---------------------------------------------------------------------------

describe("memory.ingest — selective ingest", () => {
  it("paths parameter restricts ingest to matching files", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-sel-paths-"));
    const mem = join(ws, "memory");
    mkdirSync(join(mem, "src"), { recursive: true });
    mkdirSync(join(mem, "docs"), { recursive: true });
    writeFileSync(join(mem, "src", "a.md"), "# A\n\nsrc content\n", "utf8");
    writeFileSync(join(mem, "docs", "b.md"), "# B\n\ndocs content\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    const result = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: JSON.stringify({ paths: ["src/**"], report: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(result.resultJson) as {
      changed: number;
      files?: { path: string; status: string }[];
    };
    assert.equal(j.changed, 1);
    assert.equal(j.files!.length, 1);
    assert.match(j.files![0]!.path, /src/);
    db.close();
  });

  it("exclude parameter skips matching files", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-sel-excl-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "keep.md"), "# Keep\n\nkeep\n", "utf8");
    writeFileSync(join(mem, "skip.test.md"), "# Skip\n\nskip\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    const result = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: JSON.stringify({ exclude: ["*.test.md"], report: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(result.resultJson) as {
      changed: number;
      files?: { path: string; status: string }[];
    };
    assert.equal(j.changed, 1);
    assert.match(j.files![0]!.path, /keep\.md$/);
    db.close();
  });

  it("paths and exclude compose correctly", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-sel-comp-"));
    const mem = join(ws, "memory");
    mkdirSync(join(mem, "src"), { recursive: true });
    mkdirSync(join(mem, "docs"), { recursive: true });
    writeFileSync(join(mem, "src", "main.md"), "# Main\n\nmain\n", "utf8");
    writeFileSync(join(mem, "src", "main.test.md"), "# Test\n\ntest\n", "utf8");
    writeFileSync(join(mem, "docs", "readme.md"), "# Readme\n\nreadme\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    const result = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: JSON.stringify({ paths: ["src/**"], exclude: ["**/*.test.md"], report: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(result.resultJson) as {
      changed: number;
      files?: { path: string; status: string }[];
    };
    assert.equal(j.changed, 1);
    assert.match(j.files![0]!.path, /main\.md$/);
    db.close();
  });

  it("empty paths match returns zero changes", async () => {
    const ws = mkdtempSync(join(tmpdir(), "shog-sel-empty-"));
    const mem = join(ws, "memory");
    mkdirSync(mem);
    writeFileSync(join(mem, "a.md"), "# A\n\ncontent\n", "utf8");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const memory = { paths: ["memory"], embeddings: { enabled: false } };
    const result = await runMemoryBuiltin({
      originalName: "memory.ingest",
      argsJson: JSON.stringify({ paths: ["nonexistent/**"], report: true }),
      db, workspacePath: ws, memory, env: { ...process.env },
    });
    const j = JSON.parse(result.resultJson) as { changed: number; files?: unknown[] };
    assert.equal(j.changed, 0);
    assert.deepEqual(j.files, []);
    db.close();
  });
});
