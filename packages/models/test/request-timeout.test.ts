import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createResilientFetcher } from "../src/resilient-fetch";
import { ModelResilienceGate } from "../src/resilience/gate.js";
import { createOpenAICompatibleProvider } from "../src/openai-compatible";
import type { FetchLike } from "../src/openai-compatible";

/** Gate with retries disabled so a timeout rejects on the first attempt. */
function noRetryGate(): ModelResilienceGate {
  return new ModelResilienceGate({ maxRetries: 0 });
}

/** Capture the `init` handed to fetch so we can inspect the dispatcher. */
function capturingFetch(): { fetchImpl: FetchLike; lastInit: () => RequestInit | undefined } {
  let captured: RequestInit | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    captured = init;
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl, lastInit: () => captured };
}

describe("createResilientFetcher requestTimeoutMs", () => {
  it("attaches an undici dispatcher when requestTimeoutMs is set", async () => {
    const { fetchImpl, lastInit } = capturingFetch();
    const fetcher = createResilientFetcher({
      id: "p-timeout",
      gate: noRetryGate(),
      fetchImpl,
      providerType: "openai-compatible",
      requestTimeoutMs: 1234,
    });
    await fetcher("https://example.test/v1/chat/completions", { method: "POST" });
    const dispatcher = (lastInit() as { dispatcher?: unknown } | undefined)?.dispatcher;
    expect(dispatcher).toBeDefined();
  });

  it("does not attach a dispatcher when requestTimeoutMs is omitted", async () => {
    const { fetchImpl, lastInit } = capturingFetch();
    const fetcher = createResilientFetcher({
      id: "p-no-timeout",
      gate: noRetryGate(),
      fetchImpl,
      providerType: "openai-compatible",
    });
    await fetcher("https://example.test/v1/chat/completions", { method: "POST" });
    const dispatcher = (lastInit() as { dispatcher?: unknown } | undefined)?.dispatcher;
    expect(dispatcher).toBeUndefined();
  });

  it("does not mutate the caller's original init object", async () => {
    const { fetchImpl, lastInit } = capturingFetch();
    const fetcher = createResilientFetcher({
      id: "p-immutable",
      gate: noRetryGate(),
      fetchImpl,
      providerType: "openai-compatible",
      requestTimeoutMs: 500,
    });
    const original: RequestInit = { method: "POST" };
    await fetcher("https://example.test/v1/chat/completions", original);
    expect((original as { dispatcher?: unknown }).dispatcher).toBeUndefined();
    expect((lastInit() as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });
});

describe("configured timeout enforcement", () => {
  let server: Server;
  let url: string;

  /** Start a server that accepts connections but never sends response headers. */
  async function startStallingServer(): Promise<void> {
    server = createServer(() => {
      /* Intentionally never respond — simulates a stalled/slow provider. */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/v1/chat/completions`;
  }

  it("rejects once the configured request timeout elapses (well before node's 5-min default)", async () => {
    await startStallingServer();
    try {
      // Point the provider's baseUrl at the stalling server; it appends
      // `/chat/completions`, and the server ignores the path entirely.
      const port = Number(new URL(url).port);
      const provider = createOpenAICompatibleProvider({
        id: "stalled",
        baseUrl: `http://127.0.0.1:${port}`,
        fetchImpl: globalThis.fetch as FetchLike,
        resilienceGate: noRetryGate(),
        requestTimeoutMs: 200,
      });

      const started = Date.now();
      await expect(
        provider.complete({
          model: "m",
          messages: [{ role: "user", content: "x" }],
          maxOutputTokens: 16,
        }),
      ).rejects.toThrow();
      const elapsed = Date.now() - started;
      // The stall server never responds; ensure we bailed near 200ms, not 300s.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
