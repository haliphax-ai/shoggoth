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

import { runCruiseCli } from "../src/run-cruise";

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

type Call = { op: string; payload: Record<string, unknown> };

describe("shoggoth cruise activation", () => {
  it("activates with yes/no guidance, resolving a bare agent id", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { active: true, policy: {}, warnings: [] },
    });
    await runCruiseCli(["main", "--yes", "approve routine ops", "--no", "deny risky ops"]);
    const call = mockInvoke.mock.calls[0]![0] as Call;
    assert.equal(call.op, "hitl_cruise_control");
    assert.equal(call.payload.session_id, "agent:main:discord:channel:123");
    assert.equal(call.payload.yes, "approve routine ops");
    assert.equal(call.payload.no, "deny risky ops");
    assert.equal(call.payload.escalate, undefined);
    assert.equal(call.payload.model, undefined);
    assert.equal(process.exitCode, undefined);
  });

  it("forwards escalate and model flags", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { active: true, policy: {}, warnings: [] },
    });
    await runCruiseCli([
      "agent:main:discord:channel:999",
      "--yes",
      "y",
      "--no",
      "n",
      "--escalate",
      "e",
      "--model",
      "typesafe-main/jev-latest",
    ]);
    const call = mockInvoke.mock.calls[0]![0] as Call;
    assert.equal(call.payload.session_id, "agent:main:discord:channel:999");
    assert.equal(call.payload.escalate, "e");
    assert.equal(call.payload.model, "typesafe-main/jev-latest");
  });

  it("refuses to activate without both --yes and --no", async () => {
    await runCruiseCli(["main", "--yes", "y"]);
    assert.equal(mockInvoke.mock.calls.length, 0);
    assert.equal(process.exitCode, 1);
    assert.ok(errored.some((l) => l.includes("--yes") && l.includes("--no")));
  });

  it("surfaces activation warnings on stderr", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { active: true, policy: {}, warnings: ["no cruise control model provided"] },
    });
    await runCruiseCli(["main", "--yes", "y", "--no", "n"]);
    assert.ok(errored.some((l) => l.includes("warning: no cruise control model provided")));
  });

  it("rejects unknown flags", async () => {
    await runCruiseCli(["main", "--yes", "y", "--no", "n", "--bogus", "x"]);
    assert.equal(mockInvoke.mock.calls.length, 0);
    assert.equal(process.exitCode, 1);
  });
});

describe("shoggoth cruise status/off", () => {
  it("queries status without deactivating", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { active: true, policy: { yes: "y", no: "n" } },
    });
    await runCruiseCli(["status", "main"]);
    const call = mockInvoke.mock.calls[0]![0] as Call;
    assert.equal(call.op, "hitl_cruise_control");
    assert.deepEqual(call.payload, { session_id: "agent:main:discord:channel:123" });
    assert.ok(logged.join("\n").includes('"active": true'));
  });

  it("deactivates with the deactivate flag", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { active: false, cleared: true },
    });
    await runCruiseCli(["off", "main"]);
    const call = mockInvoke.mock.calls[0]![0] as Call;
    assert.equal(call.payload.deactivate, true);
    assert.equal(call.payload.session_id, "agent:main:discord:channel:123");
  });

  it("requires a target for status/off", async () => {
    await runCruiseCli(["off"]);
    assert.equal(mockInvoke.mock.calls.length, 0);
    assert.equal(process.exitCode, 1);
  });
});
