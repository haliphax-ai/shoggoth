import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";
import { DecisionService } from "../../src/decision/decision-service";
import type { ShoggothDecisionConfig } from "@shoggoth/shared";

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

const baseConfig: ShoggothDecisionConfig = {
  providers: [
    {
      id: "typesafe-main",
      kind: "typesafe",
      baseUrl: "https://api.typesafe.ai",
      apiKey: "ts-key",
      models: [{ name: "jev-latest" }, { name: "jev-1.13.0" }],
    },
  ],
};

const noulQuestions = {
  is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
};

// ---------------------------------------------------------------------------
// DecisionService.evaluate — /v1/systemone
// ---------------------------------------------------------------------------

describe("DecisionService", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  describe("evaluate", () => {
    it("POSTs to /v1/systemone with bearer auth and spec-shaped body", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "jev-1.13.0",
          answers: { is_urgent: { type: "noul", noul: 0.95 } },
          usage: { input_tokens: 307, output_tokens: 20 },
        }),
      );

      const svc = DecisionService.fromConfig(baseConfig);
      // model is given in provider/model-id format; the wire body sends the
      // raw model name (the remote API does not know provider ids)
      const result = await svc.evaluate({
        model: "typesafe-main/jev-latest",
        state: "Help! My payouts have been failing for 3 days.",
        questions: noulQuestions,
      });

      assert.equal(fetchMock.mock.calls.length, 1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.equal(init.headers["Authorization"], "Bearer ts-key");
      assert.deepStrictEqual(JSON.parse(init.body as string), {
        state: "Help! My payouts have been failing for 3 days.",
        model: "jev-latest",
        questions: noulQuestions,
      });

      assert.equal(result.status, "complete");
      if (result.status === "complete") {
        assert.equal(result.model, "jev-1.13.0");
        assert.deepStrictEqual(result.answers, {
          is_urgent: { type: "noul", noul: 0.95 },
        });
        assert.deepStrictEqual(result.usage, { input_tokens: 307, output_tokens: 20 });
      }
    });

    it("passes structured (object) state through", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "jev-latest",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );

      const svc = DecisionService.fromConfig(baseConfig);
      await svc.evaluate({
        model: "typesafe-main/jev-latest",
        state: { messages: [{ role: "user", content: "hello" }] },
        questions: noulQuestions,
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      const body = JSON.parse(init.body as string);
      assert.deepStrictEqual(body.state, { messages: [{ role: "user", content: "hello" }] });
    });

    it("trims trailing slashes from baseUrl", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "jev-latest",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );

      const svc = DecisionService.fromConfig({
        providers: [
          {
            ...baseConfig.providers[0]!,
            baseUrl: "https://api.typesafe.ai/",
          },
        ],
      });
      await svc.evaluate({
        model: "typesafe-main/jev-latest",
        state: "s",
        questions: noulQuestions,
      });

      const [url] = fetchMock.mock.calls[0] as [string];
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    });

    it("resolves apiKey from apiKeyEnv", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "jev-latest",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      process.env.TEST_DECISION_API_KEY = "env-secret";

      try {
        const svc = DecisionService.fromConfig({
          providers: [
            {
              id: "typesafe-env",
              kind: "typesafe",
              baseUrl: "https://api.typesafe.ai",
              apiKeyEnv: "TEST_DECISION_API_KEY",
              models: [{ name: "jev-latest" }],
            },
          ],
        });
        await svc.evaluate({
          model: "typesafe-env/jev-latest",
          state: "s",
          questions: noulQuestions,
        });
      } finally {
        delete process.env.TEST_DECISION_API_KEY;
      }

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      assert.equal(init.headers["Authorization"], "Bearer env-secret");
    });

    it("returns error when model is not configured and does not call the API", async () => {
      const svc = DecisionService.fromConfig(baseConfig);
      const result = await svc.evaluate({
        model: "not-configured",
        state: "s",
        questions: noulQuestions,
      });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("not-configured"), result.error);
      }
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    it("rejects a raw model name without a provider prefix", async () => {
      const svc = DecisionService.fromConfig(baseConfig);
      // "jev-latest" exists, but only as "typesafe-main/jev-latest"
      const result = await svc.evaluate({
        model: "jev-latest",
        state: "s",
        questions: noulQuestions,
      });

      assert.equal(result.status, "error");
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    it("rejects an unknown provider prefix", async () => {
      const svc = DecisionService.fromConfig(baseConfig);
      const result = await svc.evaluate({
        model: "other-provider/jev-latest",
        state: "s",
        questions: noulQuestions,
      });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("other-provider/jev-latest"), result.error);
      }
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    it("rejects a model that is not listed under the prefixed provider", async () => {
      const svc = DecisionService.fromConfig(baseConfig);
      const result = await svc.evaluate({
        model: "typesafe-main/not-a-real-model",
        state: "s",
        questions: noulQuestions,
      });

      assert.equal(result.status, "error");
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    it("returns error on non-ok HTTP response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("The request body failed validation", { status: 422 }),
      );

      const svc = DecisionService.fromConfig(baseConfig);
      const result = await svc.evaluate({
        model: "typesafe-main/jev-latest",
        state: "s",
        questions: noulQuestions,
      });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("422"), result.error);
        assert.ok(result.error.includes("validation"), result.error);
      }
    });

    it("returns error when fetch throws", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network down"));

      const svc = DecisionService.fromConfig(baseConfig);
      const result = await svc.evaluate({
        model: "typesafe-main/jev-latest",
        state: "s",
        questions: noulQuestions,
      });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("network down"), result.error);
      }
    });

    it("sends all three question types in one request", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "jev-latest",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );

      const questions = {
        is_urgent: { type: "noul", instructions: "Urgent?" },
        department: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "Payments", technical: "Bugs" },
        },
        frustration: {
          type: "score",
          instructions: "How frustrated?",
          criteria: ["Calm", "Frustrated", "Very angry"],
        },
      };

      const svc = DecisionService.fromConfig(baseConfig);
      await svc.evaluate({ model: "typesafe-main/jev-latest", state: "s", questions });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      const body = JSON.parse(init.body as string);
      assert.deepStrictEqual(body.questions, questions);
    });
  });

  describe("default model", () => {
    const defaultConfig: ShoggothDecisionConfig = {
      ...baseConfig,
      defaultModel: "typesafe-main/jev-latest",
    };

    it("uses the configured default model when model is omitted", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "jev-latest",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );

      const svc = DecisionService.fromConfig(defaultConfig);
      const result = await svc.evaluate({ state: "s", questions: noulQuestions });

      assert.equal(fetchMock.mock.calls.length, 1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      assert.equal(JSON.parse(init.body as string).model, "jev-latest");
      assert.equal(result.status, "complete");
    });

    it("explicit model overrides the default", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "jev-1.13.0",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );

      const svc = DecisionService.fromConfig(defaultConfig);
      await svc.evaluate({
        model: "typesafe-main/jev-1.13.0",
        state: "s",
        questions: noulQuestions,
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, any>];
      assert.equal(JSON.parse(init.body as string).model, "jev-1.13.0");
    });

    it("returns error when model is omitted and no default is configured", async () => {
      const svc = DecisionService.fromConfig(baseConfig);
      const result = await svc.evaluate({ state: "s", questions: noulQuestions });

      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.ok(result.error.includes("model"), result.error);
      }
      assert.equal(fetchMock.mock.calls.length, 0);
    });
  });
});
