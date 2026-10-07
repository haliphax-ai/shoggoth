import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";

// Mock the control socket client and config loader before importing the module under test
const mockInvoke = vi.fn();
vi.mock("@shoggoth/daemon/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shoggoth/daemon/lib")>()),
  invokeControlRequest: (...args: unknown[]) => mockInvoke(...args),
  resolveSessionTargetFromCliArg: () => "sess-1",
}));

vi.mock("@shoggoth/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shoggoth/shared")>()),
  loadLayeredConfigAsync: async () => ({ socketPath: "/tmp/test.sock" }),
}));

import { runSessionCli } from "../src/run-session";

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
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  delete process.env.SHOGGOTH_CONTROL_SOCKET;
});

describe("session model", () => {
  it("formats the session_model result payload", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: {
        ok: true,
        session_id: "sess-1",
        model_selection: "anthropic/claude-3-5-sonnet",
        effective_models: { providerId: "anthropic", model: "claude-3-5-sonnet" },
      },
    });

    await runSessionCli(["model", "some-session"]);

    const out = logged.join("\n");
    assert.ok(out.includes("Session: sess-1"), `expected session in output: ${out}`);
    assert.ok(
      out.includes("Selection: anthropic/claude-3-5-sonnet"),
      `expected selection in output: ${out}`,
    );
    assert.ok(
      out.includes("Effective: anthropic/claude-3-5-sonnet"),
      `expected effective model in output: ${out}`,
    );
    assert.ok(!out.includes("undefined"), `unexpected undefined in output: ${out}`);
  });

  it("skips fields missing from the result payload", async () => {
    mockInvoke.mockResolvedValue({ v: 1, id: "req-1", ok: true, result: { ok: true } });

    await runSessionCli(["model", "some-session"]);

    const out = logged.join("\n");
    assert.ok(!out.includes("Session:"), `expected no session line: ${out}`);
    assert.ok(!out.includes("undefined"), `unexpected undefined in output: ${out}`);
    assert.ok(out.includes("(using default)"), `expected default selection: ${out}`);
  });
});
