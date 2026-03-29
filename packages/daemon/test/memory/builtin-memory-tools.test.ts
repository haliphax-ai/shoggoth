import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
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
