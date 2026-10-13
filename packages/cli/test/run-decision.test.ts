import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";

// Mock invokeControlRequest before importing the module under test
const mockInvoke = vi.fn();
vi.mock("@shoggoth/daemon/lib", () => ({
  invokeControlRequest: (...args: unknown[]) => mockInvoke(...args),
}));

const mockLoadLayeredConfig = vi.fn().mockReturnValue({ socketPath: "/tmp/test.sock" });
vi.mock("@shoggoth/shared", () => ({
  loadLayeredConfigAsync: (...args: unknown[]) => mockLoadLayeredConfig(...args),
  LAYOUT: { configDir: "/tmp/cfg" },
  VERSION: "0.0.0-test",
}));

import { parseDecisionEvaluateArgs, runDecisionCli } from "../src/run-decision";

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
  mockLoadLayeredConfig.mockReset().mockReturnValue({ socketPath: "/tmp/test.sock" });
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  delete process.env.SHOGGOTH_CONTROL_SOCKET;
});

// ---------------------------------------------------------------------------
// parseDecisionEvaluateArgs
// ---------------------------------------------------------------------------

describe("parseDecisionEvaluateArgs", () => {
  it("parses --model, --state (string), and --questions (JSON)", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "jev-latest",
      "--state",
      "Help! My payouts are failing.",
      "--questions",
      '{"is_urgent":{"type":"noul","instructions":"Urgent?"}}',
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.model, "jev-latest");
    assert.strictEqual(result.payload.state, "Help! My payouts are failing.");
    assert.deepStrictEqual(result.payload.questions, {
      is_urgent: { type: "noul", instructions: "Urgent?" },
    });
  });

  it("parses --state as JSON when valid JSON", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "jev-latest",
      "--state",
      '{"messages":[{"role":"user","content":"hi"}]}',
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
    ]);
    assert.ok(result.ok);
    assert.deepStrictEqual(result.payload.state, {
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("model is optional (config default applies)", () => {
    const result = parseDecisionEvaluateArgs([
      "--state",
      "s",
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.model, undefined);
  });

  it("rejects an empty --model", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "",
      "--state",
      "s",
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
    ]);
    assert.strictEqual(result.ok, false);
  });

  it("requires --state", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "jev-latest",
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
    ]);
    assert.strictEqual(result.ok, false);
  });

  it("requires --questions", () => {
    const result = parseDecisionEvaluateArgs(["--model", "jev-latest", "--state", "s"]);
    assert.strictEqual(result.ok, false);
  });

  it("rejects invalid --questions JSON", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "jev-latest",
      "--state",
      "s",
      "--questions",
      "not-json",
    ]);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.includes("--questions"));
    }
  });

  it("rejects non-object --questions JSON", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "jev-latest",
      "--state",
      "s",
      "--questions",
      '"just a string"',
    ]);
    assert.strictEqual(result.ok, false);
  });

  it("timeout is optional", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "jev-latest",
      "--state",
      "s",
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.timeout_ms, undefined);
  });

  it("parses --timeout", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "jev-latest",
      "--state",
      "s",
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
      "--timeout",
      "15000",
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.timeout_ms, 15000);
  });

  it("rejects non-numeric --timeout", () => {
    const result = parseDecisionEvaluateArgs([
      "--model",
      "jev-latest",
      "--state",
      "s",
      "--questions",
      "{}",
      "--timeout",
      "abc",
    ]);
    assert.strictEqual(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// shoggoth decision evaluate — control op integration
// ---------------------------------------------------------------------------

describe("runDecisionCli evaluate", () => {
  it("sends decision_evaluate control op with correct payload", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: {
        status: "complete",
        model: "jev-1.13.0",
        answers: { is_urgent: { type: "noul", noul: 0.95 } },
        usage: { input_tokens: 307, output_tokens: 20 },
      },
    });

    await runDecisionCli([
      "evaluate",
      "--model",
      "jev-latest",
      "--state",
      "Help! My payouts are failing.",
      "--questions",
      '{"is_urgent":{"type":"noul","instructions":"Urgent?"}}',
    ]);

    assert.strictEqual(mockInvoke.mock.calls.length, 1);
    const call = mockInvoke.mock.calls[0]![0] as {
      op: string;
      payload: Record<string, unknown>;
    };
    assert.strictEqual(call.op, "decision_evaluate");
    assert.strictEqual(call.payload.model, "jev-latest");
    assert.strictEqual(call.payload.state, "Help! My payouts are failing.");
    assert.deepStrictEqual(call.payload.questions, {
      is_urgent: { type: "noul", instructions: "Urgent?" },
    });
  });

  it("omits model from the payload when --model is not given", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: { status: "complete", model: "jev-latest", answers: {} },
    });

    await runDecisionCli([
      "evaluate",
      "--state",
      "s",
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
    ]);

    assert.strictEqual(mockInvoke.mock.calls.length, 1);
    const call = mockInvoke.mock.calls[0]![0] as {
      op: string;
      payload: Record<string, unknown>;
    };
    assert.strictEqual(call.op, "decision_evaluate");
    assert.strictEqual("model" in call.payload, false);
  });

  it("displays answers on success", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: {
        status: "complete",
        model: "jev-1.13.0",
        answers: { department: { type: "choice", choice: "billing" } },
      },
    });

    await runDecisionCli([
      "evaluate",
      "--model",
      "jev-latest",
      "--state",
      "s",
      "--questions",
      '{"department":{"type":"choice","instructions":"Which team?","criteria":{"billing":"Payments","technical":"Bugs"}}}',
    ]);

    const output = logged.join("\n");
    assert.ok(output.includes("billing"), `Expected answer in output: ${output}`);
  });

  it("displays error message on service failure", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: { status: "error", error: "Rate limited" },
    });

    await runDecisionCli([
      "evaluate",
      "--model",
      "jev-latest",
      "--state",
      "s",
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
    ]);

    const allOutput = [...logged, ...errored].join("\n");
    assert.ok(allOutput.includes("Rate limited"), `Expected error in output: ${allOutput}`);
    assert.strictEqual(process.exitCode, 1);
  });

  it("sets exit code when control op itself fails", async () => {
    mockInvoke.mockResolvedValue({ ok: false, error: { message: "socket unreachable" } });

    await runDecisionCli([
      "evaluate",
      "--model",
      "jev-latest",
      "--state",
      "s",
      "--questions",
      '{"q":{"type":"noul","instructions":"ok?"}}',
    ]);

    assert.strictEqual(process.exitCode, 1);
  });

  it("sets exit code on missing required args without invoking control op", async () => {
    await runDecisionCli(["evaluate", "--model", "jev-latest"]);
    assert.strictEqual(process.exitCode, 1);
    assert.strictEqual(mockInvoke.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// shoggoth decision models
// ---------------------------------------------------------------------------

describe("runDecisionCli models", () => {
  it("lists configured models from decision providers, marking the default", async () => {
    mockLoadLayeredConfig.mockReturnValue({
      socketPath: "/tmp/test.sock",
      decision: {
        defaultModel: "jev-latest",
        providers: [
          {
            id: "typesafe-main",
            kind: "typesafe",
            baseUrl: "https://api.typesafe.ai",
            models: [{ name: "jev-latest" }, { name: "jev-1.13.0" }],
          },
        ],
      },
    });

    await runDecisionCli(["models"]);

    const output = logged.join("\n");
    assert.ok(output.includes("jev-latest"), `Expected model in output: ${output}`);
    assert.ok(output.includes("jev-1.13.0"), `Expected model in output: ${output}`);
    assert.ok(output.includes("typesafe-main"), `Expected provider id in output: ${output}`);
    assert.ok(output.includes("(default)"), `Expected default marker in output: ${output}`);
    assert.strictEqual(mockInvoke.mock.calls.length, 0);
  });

  it("reports when no decision providers are configured", async () => {
    mockLoadLayeredConfig.mockReturnValue({ socketPath: "/tmp/test.sock" });

    await runDecisionCli(["models"]);

    const output = logged.join("\n");
    assert.ok(output.toLowerCase().includes("no decision"), `Expected notice: ${output}`);
  });
});
