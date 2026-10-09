import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";

// Mock the control socket client before importing the module under test
const mockInvoke = vi.fn();
vi.mock("@shoggoth/daemon/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shoggoth/daemon/lib")>()),
  invokeControlRequest: (...args: unknown[]) => mockInvoke(...args),
  resolveSessionTargetFromCliArg: (raw: string) =>
    raw === "main" ? "agent:main:discord:channel:123" : raw,
}));

vi.mock("@shoggoth/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shoggoth/shared")>()),
  loadLayeredConfigAsync: async () => ({ socketPath: "/tmp/test.sock" }),
}));

import { runHitlCli } from "../src/run-hitl";

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

describe("hitl list session target resolution", () => {
  it("resolves a bare agent id to a session URN before invoking the control op", async () => {
    mockInvoke.mockResolvedValue({ v: 1, id: "req-1", ok: true, result: { pending: [] } });
    await runHitlCli(["list", "main"]);
    const call = mockInvoke.mock.calls[0]?.[0] as {
      op: string;
      payload: { session_id?: string };
    };
    assert.equal(call.op, "hitl_pending_list");
    assert.equal(call.payload.session_id, "agent:main:discord:channel:123");
  });

  it("passes a full session URN through unchanged", async () => {
    mockInvoke.mockResolvedValue({ v: 1, id: "req-1", ok: true, result: { pending: [] } });
    await runHitlCli(["list", "agent:main:discord:channel:999"]);
    const call = mockInvoke.mock.calls[0]?.[0] as { payload: { session_id?: string } };
    assert.equal(call.payload.session_id, "agent:main:discord:channel:999");
  });
});

describe("hitl clear --session target resolution", () => {
  it("resolves a bare agent id --session to a session URN", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { deleted_pending: 0, session_ids: [] },
    });
    await runHitlCli(["clear", "main", "--session", "main"]);
    const call = mockInvoke.mock.calls[0]?.[0] as {
      op: string;
      payload: { agent_id?: string; session_id?: string };
    };
    assert.equal(call.op, "hitl_clear");
    assert.equal(call.payload.agent_id, "main");
    assert.equal(call.payload.session_id, "agent:main:discord:channel:123");
  });

  it("passes a full session URN --session through unchanged", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { deleted_pending: 0, session_ids: [] },
    });
    await runHitlCli(["clear", "all", "--session", "agent:main:discord:channel:999"]);
    const call = mockInvoke.mock.calls[0]?.[0] as {
      payload: { agent_id?: string; session_id?: string };
    };
    assert.equal(call.payload.agent_id, "all");
    assert.equal(call.payload.session_id, "agent:main:discord:channel:999");
  });
});
