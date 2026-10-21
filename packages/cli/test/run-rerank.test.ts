import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";

// Mock invokeControlRequest before importing the module under test
const mockInvoke = vi.fn();
vi.mock("@shoggoth/daemon/lib", () => ({
  invokeControlRequest: (...args: unknown[]) => mockInvoke(...args),
}));

const mockLoadLayeredConfig = vi.fn();
vi.mock("@shoggoth/shared", () => ({
  loadLayeredConfigAsync: (...args: unknown[]) => mockLoadLayeredConfig(...args),
  LAYOUT: { configDir: "/tmp/cfg" },
  VERSION: "0.0.0-test",
}));

/** Default: rerank support configured (provider with models). */
function configuredRerankConfig() {
  return {
    socketPath: "/tmp/test.sock",
    rerank: {
      defaultModel: "openrouter-cohere/cohere/rerank-v3.5",
      providers: {
        "openrouter-cohere": {
          kind: "cohere",
          baseUrl: "https://openrouter.ai/api",
          models: [{ name: "cohere/rerank-v3.5" }],
        },
      },
    },
  };
}

/** Rerank support absent: no rerank section at all. */
function unconfiguredRerankConfig() {
  return { socketPath: "/tmp/test.sock" };
}

import { parseRerankRankArgs, runRerankCli } from "../src/run-rerank";

let logged: string[] = [];
let errored: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logged = [];
  errored = [];
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errored.push(args.map(String).join(" "));
  process.exitCode = undefined;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-token";
  process.env.SHOGGOTH_CONTROL_SOCKET = "/tmp/test.sock";
  mockInvoke.mockReset();
  mockLoadLayeredConfig.mockReset().mockReturnValue(configuredRerankConfig());
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  delete process.env.SHOGGOTH_CONTROL_SOCKET;
});

// ---------------------------------------------------------------------------
// parseRerankRankArgs
// ---------------------------------------------------------------------------

describe("parseRerankRankArgs", () => {
  it("parses --model, --query, and --documents (JSON array)", () => {
    const result = parseRerankRankArgs([
      "--model",
      "openrouter-cohere/cohere/rerank-v3.5",
      "--query",
      "Where is my billing history?",
      "--documents",
      '["Billing history lives in the dashboard.","Shipping policies."]',
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.model, "openrouter-cohere/cohere/rerank-v3.5");
    assert.strictEqual(result.payload.query, "Where is my billing history?");
    assert.deepStrictEqual(result.payload.documents, [
      "Billing history lives in the dashboard.",
      "Shipping policies.",
    ]);
  });

  it("model is optional (config default applies)", () => {
    const result = parseRerankRankArgs(["--query", "q", "--documents", '["a"]']);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.model, undefined);
  });

  it("parses --top and --timeout", () => {
    const result = parseRerankRankArgs([
      "--query",
      "q",
      "--documents",
      '["a","b"]',
      "--top",
      "2",
      "--timeout",
      "5000",
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.top_n, 2);
    assert.strictEqual(result.payload.timeout_ms, 5000);
  });

  it("rejects an empty --model", () => {
    const result = parseRerankRankArgs(["--model", "", "--query", "q", "--documents", '["a"]']);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("--model"));
  });

  it("rejects a missing --query", () => {
    const result = parseRerankRankArgs(["--documents", '["a"]']);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("--query"));
  });

  it("rejects a blank --query", () => {
    const result = parseRerankRankArgs(["--query", "   ", "--documents", '["a"]']);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("--query"));
  });

  it("rejects a missing --documents", () => {
    const result = parseRerankRankArgs(["--query", "q"]);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("--documents"));
  });

  it("rejects --documents that is not valid JSON", () => {
    const result = parseRerankRankArgs(["--query", "q", "--documents", "not json"]);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("JSON"));
  });

  it("rejects an empty --documents array", () => {
    const result = parseRerankRankArgs(["--query", "q", "--documents", "[]"]);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("--documents"));
  });

  it("rejects non-string documents", () => {
    const result = parseRerankRankArgs(["--query", "q", "--documents", '["ok",42]']);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("strings"));
  });

  it("rejects a non-numeric --top", () => {
    const result = parseRerankRankArgs(["--query", "q", "--documents", '["a"]', "--top", "two"]);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("--top"));
  });

  it("rejects a non-numeric --timeout", () => {
    const result = parseRerankRankArgs([
      "--query",
      "q",
      "--documents",
      '["a"]',
      "--timeout",
      "soon",
    ]);
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("--timeout"));
  });
});

// ---------------------------------------------------------------------------
// runRerankCli — feature gating
// ---------------------------------------------------------------------------

describe("runRerankCli feature gating", () => {
  it("is inert with exit code 1 when rerank is not configured", async () => {
    mockLoadLayeredConfig.mockReturnValue(unconfiguredRerankConfig());

    await runRerankCli(["rank", "--query", "q", "--documents", '["a"]']);

    assert.strictEqual(process.exitCode, 1);
    assert.ok(errored.some((l) => l.includes("not configured")));
    assert.strictEqual(mockInvoke.mock.calls.length, 0);
  });

  it("is inert (including help) when providers have no models", async () => {
    mockLoadLayeredConfig.mockReturnValue({
      socketPath: "/tmp/test.sock",
      rerank: { providers: { p1: { kind: "cohere", baseUrl: "https://x", models: [] } } },
    });

    await runRerankCli(["--help"]);

    assert.strictEqual(process.exitCode, 1);
    assert.ok(errored.some((l) => l.includes("not configured")));
  });
});

// ---------------------------------------------------------------------------
// runRerankCli — help and models
// ---------------------------------------------------------------------------

describe("runRerankCli help and models", () => {
  it("prints help when configured", async () => {
    await runRerankCli(["--help"]);
    assert.ok(logged.some((l) => l.includes("shoggoth rerank rank")));
    assert.strictEqual(process.exitCode, undefined);
  });

  it("lists configured models with the default marked", async () => {
    await runRerankCli(["models"]);
    assert.strictEqual(logged.length, 1);
    assert.ok(logged[0].includes("openrouter-cohere/cohere/rerank-v3.5"));
    assert.ok(logged[0].includes("(default)"));
    assert.ok(logged[0].includes("cohere"));
  });
});

// ---------------------------------------------------------------------------
// runRerankCli — rank
// ---------------------------------------------------------------------------

describe("runRerankCli rank", () => {
  it("sends rerank_documents control op with correct payload", async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      result: {
        status: "complete",
        model: "cohere/rerank-v3.5",
        results: [{ index: 0, relevance_score: 0.97 }],
      },
    });

    await runRerankCli([
      "rank",
      "--model",
      "openrouter-cohere/cohere/rerank-v3.5",
      "--query",
      "Where is my billing history?",
      "--documents",
      '["Billing history lives in the dashboard.","Shipping policies."]',
      "--top",
      "1",
    ]);

    assert.strictEqual(mockInvoke.mock.calls.length, 1);
    const call = mockInvoke.mock.calls[0]![0] as {
      op: string;
      payload: Record<string, unknown>;
    };
    assert.strictEqual(call.op, "rerank_documents");
    assert.strictEqual(call.payload.model, "openrouter-cohere/cohere/rerank-v3.5");
    assert.strictEqual(call.payload.query, "Where is my billing history?");
    assert.deepStrictEqual(call.payload.documents, [
      "Billing history lives in the dashboard.",
      "Shipping policies.",
    ]);
    assert.strictEqual(call.payload.top_n, 1);

    assert.ok(logged.some((l) => l.includes("relevance_score")));
    assert.strictEqual(process.exitCode, undefined);
  });

  it("omits model and top_n from the payload when not given", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, result: { status: "complete", results: [] } });

    await runRerankCli(["rank", "--query", "q", "--documents", '["a"]']);

    const call = mockInvoke.mock.calls[0]![0] as { payload: Record<string, unknown> };
    assert.ok(!("model" in call.payload));
    assert.ok(!("top_n" in call.payload));
  });

  it("prints the JSON result on success", async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      result: { status: "complete", model: "m", results: [{ index: 0, relevance_score: 0.5 }] },
    });

    await runRerankCli(["rank", "--query", "q", "--documents", '["a"]']);

    assert.ok(logged.some((l) => l.includes("0.5")));
  });

  it("prints service errors and sets exit code 1", async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      result: { status: "error", error: "Model does not exist" },
    });

    await runRerankCli(["rank", "--query", "q", "--documents", '["a"]']);

    assert.ok(errored.some((l) => l.includes("Model does not exist")));
    assert.strictEqual(process.exitCode, 1);
  });

  it("prints control failures and sets exit code 1", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "ERR_FORBIDDEN" });

    await runRerankCli(["rank", "--query", "q", "--documents", '["a"]']);

    assert.ok(errored.some((l) => l.includes("ERR_FORBIDDEN")));
    assert.strictEqual(process.exitCode, 1);
  });

  it("rejects invalid args with usage and exit code 1", async () => {
    await runRerankCli(["rank", "--query", "q"]);

    assert.ok(errored.some((l) => l.includes("--documents")));
    assert.ok(errored.some((l) => l.includes("usage:")));
    assert.strictEqual(process.exitCode, 1);
    assert.strictEqual(mockInvoke.mock.calls.length, 0);
  });

  it("prints help and sets exit code 1 for unknown subcommands", async () => {
    await runRerankCli(["frobnicate"]);

    assert.ok(logged.some((l) => l.includes("shoggoth rerank rank")));
    assert.strictEqual(process.exitCode, 1);
  });
});
