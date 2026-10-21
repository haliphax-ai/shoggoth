import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";
import { RerankService, extractRerankErrorMessage } from "../../src/rerank/rerank-service";
import type { ShoggothRerankConfig } from "@shoggoth/shared";

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseConfig: ShoggothRerankConfig = {
  providers: {
    "openrouter-cohere": {
      kind: "cohere",
      baseUrl: "https://openrouter.ai/api",
      apiKey: "or-key",
      models: [
        { name: "cohere/rerank-v3.5" },
        { name: "nvidia/llama-nemotron-rerank-vl-1b-v2:free" },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// RerankService.rerank — /v1/rerank
// ---------------------------------------------------------------------------

describe("RerankService", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  describe("rerank", () => {
    it("POSTs to /v1/rerank with bearer auth and spec-shaped body", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "cohere/rerank-v3.5",
          results: [
            { index: 1, relevance_score: 0.987, document: { text: "doc two" } },
            { index: 0, relevance_score: 0.12, document: { text: "doc one" } },
          ],
          meta: { api_version: "v1" },
        }),
      );

      const svc = RerankService.fromConfig(baseConfig);
      // model is given in provider/model-id format; the wire body sends the
      // raw model name (the remote API does not know provider ids)
      const result = await svc.rerank({
        model: "openrouter-cohere/cohere/rerank-v3.5",
        query: "Where can I review my billing history?",
        documents: ["doc one", "doc two"],
      });

      assert.equal(fetchMock.mock.calls.length, 1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      assert.equal(url, "https://openrouter.ai/api/v1/rerank");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.equal(init.headers["Authorization"], "Bearer or-key");
      assert.deepStrictEqual(JSON.parse(init.body as string), {
        model: "cohere/rerank-v3.5",
        query: "Where can I review my billing history?",
        documents: ["doc one", "doc two"],
      });

      assert.equal(result.status, "complete");
      if (result.status === "complete") {
        assert.equal(result.model, "cohere/rerank-v3.5");
        assert.deepStrictEqual(result.results, [
          { index: 1, relevance_score: 0.987, document: "doc two" },
          { index: 0, relevance_score: 0.12, document: "doc one" },
        ]);
        assert.deepStrictEqual(result.meta, { api_version: "v1" });
      }
    });

    it("sends top_n when provided and omits it otherwise", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

      const svc = RerankService.fromConfig(baseConfig);
      await svc.rerank({
        model: "openrouter-cohere/cohere/rerank-v3.5",
        query: "q",
        documents: ["a"],
        top_n: 1,
      });
      await svc.rerank({
        model: "openrouter-cohere/cohere/rerank-v3.5",
        query: "q",
        documents: ["a"],
      });

      const bodyOne = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
      const bodyTwo = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
      assert.equal(bodyOne.top_n, 1);
      assert.ok(!("top_n" in bodyTwo));
    });

    it("tolerates results without a document echo and drops malformed entries", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          results: [
            { index: 0, relevance_score: 0.5 },
            { index: "bad", relevance_score: 0.4 },
          ],
        }),
      );

      const svc = RerankService.fromConfig(baseConfig);
      const result = await svc.rerank({
        model: "openrouter-cohere/cohere/rerank-v3.5",
        query: "q",
        documents: ["a", "b"],
      });

      assert.equal(result.status, "complete");
      if (result.status === "complete") {
        assert.deepStrictEqual(result.results, [{ index: 0, relevance_score: 0.5 }]);
      }
    });

    it("trims trailing slashes from baseUrl", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

      const svc = RerankService.fromConfig({
        providers: {
          "openrouter-cohere": {
            ...baseConfig.providers["openrouter-cohere"]!,
            baseUrl: "https://openrouter.ai/api/",
          },
        },
      });
      await svc.rerank({
        model: "openrouter-cohere/cohere/rerank-v3.5",
        query: "q",
        documents: ["a"],
      });

      const [url] = fetchMock.mock.calls[0] as [string];
      assert.equal(url, "https://openrouter.ai/api/v1/rerank");
    });

    it("resolves apiKey from apiKeyEnv", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
      process.env.TEST_RERANK_API_KEY = "env-secret";

      try {
        const svc = RerankService.fromConfig({
          providers: {
            "cohere-env": {
              kind: "cohere",
              baseUrl: "https://api.cohere.com",
              apiKeyEnv: "TEST_RERANK_API_KEY",
              models: [{ name: "rerank-v3.5" }],
            },
          },
        });
        await svc.rerank({
          model: "cohere-env/rerank-v3.5",
          query: "q",
          documents: ["a"],
        });
      } finally {
        delete process.env.TEST_RERANK_API_KEY;
      }

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      assert.equal(init.headers["Authorization"], "Bearer env-secret");
    });

    it("returns error when model is not configured and does not call the API", async () => {
      const svc = RerankService.fromConfig(baseConfig);
      const result = await svc.rerank({
        model: "not-configured",
        query: "q",
        documents: ["a"],
      });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("not-configured"), result.error);
      }
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    it("rejects a raw model name without a provider prefix", async () => {
      const svc = RerankService.fromConfig(baseConfig);
      const result = await svc.rerank({
        model: "cohere/rerank-v3.5",
        query: "q",
        documents: ["a"],
      });

      assert.equal(result.status, "error");
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    it("rejects an unknown provider prefix", async () => {
      const svc = RerankService.fromConfig(baseConfig);
      const result = await svc.rerank({
        model: "other-provider/cohere/rerank-v3.5",
        query: "q",
        documents: ["a"],
      });

      assert.equal(result.status, "error");
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    it("extracts OpenRouter's error envelope on non-ok HTTP response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "Model nonexistent/model-xyz does not exist", code: 400 },
          }),
          { status: 400 },
        ),
      );

      const svc = RerankService.fromConfig(baseConfig);
      const result = await svc.rerank({
        model: "openrouter-cohere/cohere/rerank-v3.5",
        query: "q",
        documents: ["a"],
      });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("400"), result.error);
        assert.ok(result.error.includes("does not exist"), result.error);
      }
    });

    it("falls back to the raw body text for non-JSON error responses", async () => {
      fetchMock.mockResolvedValueOnce(new Response("upstream exploded", { status: 502 }));

      const svc = RerankService.fromConfig(baseConfig);
      const result = await svc.rerank({
        model: "openrouter-cohere/cohere/rerank-v3.5",
        query: "q",
        documents: ["a"],
      });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("502"), result.error);
        assert.ok(result.error.includes("upstream exploded"), result.error);
      }
    });

    it("returns error when fetch throws", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network down"));

      const svc = RerankService.fromConfig(baseConfig);
      const result = await svc.rerank({
        model: "openrouter-cohere/cohere/rerank-v3.5",
        query: "q",
        documents: ["a"],
      });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("network down"), result.error);
      }
    });
  });

  describe("default model", () => {
    const defaultConfig: ShoggothRerankConfig = {
      ...baseConfig,
      defaultModel: "openrouter-cohere/cohere/rerank-v3.5",
    };

    it("uses the configured default model when model is omitted", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

      const svc = RerankService.fromConfig(defaultConfig);
      const result = await svc.rerank({ query: "q", documents: ["a"] });

      assert.equal(fetchMock.mock.calls.length, 1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      assert.equal(JSON.parse(init.body as string).model, "cohere/rerank-v3.5");
      assert.equal(result.status, "complete");
    });

    it("explicit model overrides the default", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

      const svc = RerankService.fromConfig(defaultConfig);
      await svc.rerank({
        model: "openrouter-cohere/nvidia/llama-nemotron-rerank-vl-1b-v2:free",
        query: "q",
        documents: ["a"],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      assert.equal(
        JSON.parse(init.body as string).model,
        "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
      );
    });

    it("returns error when model is omitted and no default is configured", async () => {
      const svc = RerankService.fromConfig(baseConfig);
      const result = await svc.rerank({ query: "q", documents: ["a"] });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("model"), result.error);
      }
      assert.equal(fetchMock.mock.calls.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// extractRerankErrorMessage — OpenRouter vs Cohere error envelopes
// ---------------------------------------------------------------------------

describe("extractRerankErrorMessage", () => {
  it("extracts OpenRouter's {error:{message,code}} envelope", () => {
    const msg = extractRerankErrorMessage(
      JSON.stringify({ error: { message: "Model does not exist", code: 400 } }),
    );
    assert.equal(msg, "Model does not exist");
  });

  it("extracts Cohere's {message} envelope", () => {
    const msg = extractRerankErrorMessage(JSON.stringify({ message: "validation failed" }));
    assert.equal(msg, "validation failed");
  });

  it("passes through a plain string error envelope", () => {
    const msg = extractRerankErrorMessage(JSON.stringify({ error: "quota exceeded" }));
    assert.equal(msg, "quota exceeded");
  });

  it("falls back to the raw body when not JSON", () => {
    assert.equal(extractRerankErrorMessage("<html>bad gateway</html>"), "<html>bad gateway</html>");
  });
});
