import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { runMemoryBuiltin } from "../../src/memory/builtin-memory-tools";
import type { FetchLike } from "@shoggoth/models";

// ---------------------------------------------------------------------------
// RAG integration: the optional rerank step of memory-search
// ---------------------------------------------------------------------------

const rerankConfig = {
  defaultModel: "openrouter-cohere/cohere/rerank-v3.5",
  providers: [
    {
      id: "openrouter-cohere",
      kind: "cohere" as const,
      baseUrl: "https://openrouter.ai/api",
      apiKey: "or-key",
      models: [{ name: "cohere/rerank-v3.5" }, { name: "other-rerank-model" }],
    },
  ],
};

async function setup() {
  const ws = mkdtempSync(join(tmpdir(), "shog-mem-ws-"));
  const mem = join(ws, "memory");
  mkdirSync(mem);
  writeFileSync(join(mem, "alpha.md"), "# Alpha\n\nzanzibar billingalpha uniquealpha\n");
  writeFileSync(join(mem, "beta.md"), "# Beta\n\nbetanumeric uniquebeta zanzibar\n");
  writeFileSync(join(mem, "gamma.md"), "# Gamma\n\nuniquegamma gammabeta zanzibar\n");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());

  const memory = { paths: ["memory"], embeddings: { enabled: false } };

  await runMemoryBuiltin({
    originalName: "memory-ingest",
    argsJson: "{}",
    db,
    workspacePath: ws,
    memory,
    env: { ...process.env },
  });

  return { ws, db, memory };
}

/** fetch stub that serves a canned Cohere-style rerank response (reversed order). */
function rerankFetch(calls: unknown[]): FetchLike {
  return (async (url: unknown, init?: unknown) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        model: "cohere/rerank-v3.5",
        results: [
          { index: 2, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.42 },
          { index: 1, relevance_score: 0.13 },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as FetchLike;
}

/** Map a sent document body back to its note title via a distinctive token. */
function titleOf(doc: string): string {
  if (doc.includes("billingalpha")) return "Alpha";
  if (doc.includes("betanumeric")) return "Beta";
  return "Gamma";
}

describe("memory-search rerank step", () => {
  it("reorders hits by relevance, attaches rerank scores, and flags reranked", async () => {
    const { ws, db, memory } = await setup();
    const calls: unknown[] = [];

    const sr = await runMemoryBuiltin({
      originalName: "memory-search",
      argsJson: JSON.stringify({ query: "zanzibar", limit: 5, rerank: true }),
      db,
      workspacePath: ws,
      memory,
      env: { ...process.env },
      fetchImpl: rerankFetch(calls),
      rerank: rerankConfig,
    });

    const parsed = JSON.parse(sr.resultJson) as {
      hits: { title: string; rerankScore?: number }[];
      reranked?: boolean;
      rerankNote?: string;
    };

    assert.equal(calls.length, 1);
    const call = calls[0] as { url: string; init: { body: string } };
    assert.equal(call.url, "https://openrouter.ai/api/v1/rerank");
    const body = JSON.parse(call.init.body) as {
      model: string;
      query: string;
      documents: string[];
    };
    assert.equal(body.model, "cohere/rerank-v3.5");
    assert.equal(body.query, "zanzibar");
    assert.equal(body.documents.length, 3);

    assert.equal(parsed.reranked, true);
    assert.equal(parsed.rerankNote, undefined);
    // the stub reverses the order it was sent (indices 2, 0, 1)
    assert.deepEqual(
      parsed.hits.map((h) => h.title),
      [titleOf(body.documents[2]!), titleOf(body.documents[0]!), titleOf(body.documents[1]!)],
    );
    assert.equal(parsed.hits[0]!.rerankScore, 0.91);
    assert.equal(parsed.hits[1]!.rerankScore, 0.42);
    assert.equal(parsed.hits[2]!.rerankScore, 0.13);

    db.close();
  });

  it("forwards rerank_model as the raw wire model name", async () => {
    const { ws, db, memory } = await setup();
    const calls: unknown[] = [];

    await runMemoryBuiltin({
      originalName: "memory-search",
      argsJson: JSON.stringify({
        query: "zanzibar",
        rerank: true,
        rerank_model: "openrouter-cohere/other-rerank-model",
      }),
      db,
      workspacePath: ws,
      memory,
      env: { ...process.env },
      fetchImpl: rerankFetch(calls),
      rerank: rerankConfig,
    });

    const call = calls[0] as { init: { body: string } };
    assert.equal(JSON.parse(call.init.body).model, "other-rerank-model");

    db.close();
  });

  it("degrades gracefully to retrieval order when the rerank call fails", async () => {
    const { ws, db, memory } = await setup();
    const failingFetch = (async () => new Response("upstream down", { status: 503 })) as FetchLike;

    const sr = await runMemoryBuiltin({
      originalName: "memory-search",
      argsJson: JSON.stringify({ query: "zanzibar", rerank: true }),
      db,
      workspacePath: ws,
      memory,
      env: { ...process.env },
      fetchImpl: failingFetch,
      rerank: rerankConfig,
    });

    const parsed = JSON.parse(sr.resultJson) as {
      hits: { title: string; rerankScore?: number }[];
      reranked?: boolean;
      rerankNote?: string;
    };

    assert.equal(parsed.reranked, undefined);
    assert.ok(parsed.rerankNote?.includes("rerank failed"));
    assert.deepEqual(parsed.hits.map((h) => h.title).sort(), ["Alpha", "Beta", "Gamma"]);
    assert.equal(parsed.hits[0]!.rerankScore, undefined);

    db.close();
  });

  it("notes but does not call out when rerank is requested but unconfigured", async () => {
    const { ws, db, memory } = await setup();
    const calls: unknown[] = [];

    const sr = await runMemoryBuiltin({
      originalName: "memory-search",
      argsJson: JSON.stringify({ query: "zanzibar", rerank: true }),
      db,
      workspacePath: ws,
      memory,
      env: { ...process.env },
      fetchImpl: rerankFetch(calls),
      // no rerank config passed
    });

    const parsed = JSON.parse(sr.resultJson) as {
      hits: { title: string }[];
      reranked?: boolean;
      rerankNote?: string;
    };

    assert.equal(calls.length, 0);
    assert.equal(parsed.reranked, undefined);
    assert.ok(parsed.rerankNote?.includes("not configured"));
    assert.deepEqual(parsed.hits.map((h) => h.title).sort(), ["Alpha", "Beta", "Gamma"]);

    db.close();
  });

  it("does not rerank (or call out) when the rerank arg is absent", async () => {
    const { ws, db, memory } = await setup();
    const calls: unknown[] = [];

    const sr = await runMemoryBuiltin({
      originalName: "memory-search",
      argsJson: JSON.stringify({ query: "zanzibar", limit: 5 }),
      db,
      workspacePath: ws,
      memory,
      env: { ...process.env },
      fetchImpl: rerankFetch(calls),
      rerank: rerankConfig,
    });

    const parsed = JSON.parse(sr.resultJson) as {
      hits: { title: string }[];
      reranked?: boolean;
    };

    assert.equal(calls.length, 0);
    assert.equal(parsed.reranked, undefined);
    assert.equal(parsed.hits.length, 3);

    db.close();
  });
});
