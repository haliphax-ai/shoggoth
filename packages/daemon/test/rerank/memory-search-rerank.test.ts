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
// RAG integration: the automatic, config-driven rerank step of memory-search.
// Reranking runs by default when rerank.defaultModel is configured; setting
// rerank.memorySearch.enabled to false opts out. There are no per-call
// rerank parameters.
// ---------------------------------------------------------------------------

const rerankConfigBase = {
  defaultModel: "openrouter-cohere/cohere/rerank-v3.5",
  providers: {
    "openrouter-cohere": {
      kind: "cohere" as const,
      baseUrl: "https://openrouter.ai/api",
      apiKey: "or-key",
      models: { "cohere/rerank-v3.5": {}, "other-rerank-model": {} },
    },
  },
};

const rerankConfig = { ...rerankConfigBase, memorySearch: { enabled: true } };

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

type SearchResponse = {
  hits: { title: string; rerankScore?: number }[];
  reranked?: boolean;
  rerankModel?: string;
  rerankNote?: string;
};

describe("memory-search rerank step (config-driven)", () => {
  it("reranks automatically when a default model is configured (no memorySearch stanza)", async () => {
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
      rerank: rerankConfigBase,
    });

    const parsed = JSON.parse(sr.resultJson) as SearchResponse;

    assert.equal(calls.length, 1);
    const call = calls[0] as { url: string; init: { body: string } };
    assert.equal(call.url, "https://openrouter.ai/api/v1/rerank");
    const body = JSON.parse(call.init.body) as {
      model: string;
      query: string;
      documents: string[];
    };
    // the wire model is the raw name from the configured defaultModel
    assert.equal(body.model, "cohere/rerank-v3.5");
    assert.equal(body.query, "zanzibar");
    assert.equal(body.documents.length, 3);

    assert.equal(parsed.reranked, true);
    assert.equal(parsed.rerankModel, "cohere/rerank-v3.5");
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

  it("returns plain retrieval order when explicitly opted out (enabled: false)", async () => {
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
      rerank: { ...rerankConfigBase, memorySearch: { enabled: false } },
    });

    const parsed = JSON.parse(sr.resultJson) as SearchResponse;

    assert.equal(calls.length, 0);
    assert.equal(parsed.reranked, undefined);
    assert.equal(parsed.rerankNote, undefined);
    assert.deepEqual(parsed.hits.map((h) => h.title).sort(), ["Alpha", "Beta", "Gamma"]);
    assert.equal(parsed.hits[0]!.rerankScore, undefined);

    db.close();
  });

  it("reranks automatically when the memorySearch stanza omits enabled (schema default true)", async () => {
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
      rerank: { ...rerankConfigBase, memorySearch: {} },
    });

    const parsed = JSON.parse(sr.resultJson) as SearchResponse;

    assert.equal(calls.length, 1);
    assert.equal(parsed.reranked, true);
    assert.equal(parsed.rerankNote, undefined);
    assert.equal(parsed.hits[0]!.rerankScore, 0.91);

    db.close();
  });

  it("does not rerank when reranking is on by default but no default model is configured", async () => {
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
      rerank: { providers: rerankConfigBase.providers },
    });

    const parsed = JSON.parse(sr.resultJson) as SearchResponse;

    assert.equal(calls.length, 0);
    assert.equal(parsed.reranked, undefined);
    assert.equal(parsed.rerankNote, undefined);
    assert.deepEqual(parsed.hits.map((h) => h.title).sort(), ["Alpha", "Beta", "Gamma"]);

    db.close();
  });

  it("degrades gracefully to retrieval order when the rerank call fails", async () => {
    const { ws, db, memory } = await setup();
    const failingFetch = (async () => new Response("upstream down", { status: 503 })) as FetchLike;

    const sr = await runMemoryBuiltin({
      originalName: "memory-search",
      argsJson: JSON.stringify({ query: "zanzibar" }),
      db,
      workspacePath: ws,
      memory,
      env: { ...process.env },
      fetchImpl: failingFetch,
      rerank: rerankConfig,
    });

    const parsed = JSON.parse(sr.resultJson) as SearchResponse;

    assert.equal(parsed.reranked, undefined);
    assert.ok(parsed.rerankNote?.includes("rerank failed"));
    assert.deepEqual(parsed.hits.map((h) => h.title).sort(), ["Alpha", "Beta", "Gamma"]);
    assert.equal(parsed.hits[0]!.rerankScore, undefined);

    db.close();
  });
});
