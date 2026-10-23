import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";

// Mock the control socket client before importing the module under test
const mockInvoke = vi.fn();
vi.mock("@shoggoth/daemon/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shoggoth/daemon/lib")>()),
  invokeControlRequest: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@shoggoth/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shoggoth/shared")>()),
  loadLayeredConfigAsync: async () => ({ socketPath: "/tmp/test.sock" }),
}));

import { runYoloCli } from "../src/run-yolo";

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

describe("shoggoth yolo", () => {
  it("turns yolo mode on for a session", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { ok: true, sessionId: "sess-1", enabled: true },
    });
    await runYoloCli(["on", "sess-1"]);
    const call = mockInvoke.mock.calls[0]![0] as Call;
    assert.equal(call.op, "yolo_mode");
    assert.deepEqual(call.payload, { action: "on", session_id: "sess-1" });
    assert.equal(process.exitCode, undefined);
    assert.ok(logged.some((l) => l.includes('"enabled": true')));
  });

  it("turns yolo mode off for a session", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { ok: true, sessionId: "sess-1", enabled: false },
    });
    await runYoloCli(["off", "sess-1"]);
    const call = mockInvoke.mock.calls[0]![0] as Call;
    assert.equal(call.op, "yolo_mode");
    assert.deepEqual(call.payload, { action: "off", session_id: "sess-1" });
    assert.equal(process.exitCode, undefined);
  });

  it("reports status for a session", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: true,
      result: { ok: true, sessionId: "sess-1", enabled: true },
    });
    await runYoloCli(["status", "sess-1"]);
    const call = mockInvoke.mock.calls[0]![0] as Call;
    assert.equal(call.op, "yolo_mode");
    assert.deepEqual(call.payload, { action: "status", session_id: "sess-1" });
    assert.equal(process.exitCode, undefined);
  });

  it("requires a session id", async () => {
    await runYoloCli(["on"]);
    assert.equal(mockInvoke.mock.calls.length, 0);
    assert.equal(process.exitCode, 1);
    assert.ok(errored.some((e) => e.includes("usage: shoggoth yolo on <session-id>")));
  });

  it("rejects unknown actions with help and exit code 1", async () => {
    await runYoloCli(["maybe", "sess-1"]);
    assert.equal(mockInvoke.mock.calls.length, 0);
    assert.equal(process.exitCode, 1);
    assert.ok(logged.some((l) => l.includes("shoggoth yolo on <session-id>")));
  });

  it("prints help without invoking the control socket", async () => {
    await runYoloCli(["--help"]);
    assert.equal(mockInvoke.mock.calls.length, 0);
    assert.equal(process.exitCode, undefined);
    assert.ok(logged.some((l) => l.includes("shoggoth yolo status <session-id>")));
  });

  it("propagates a failed control response with exit code 1", async () => {
    mockInvoke.mockResolvedValue({
      v: 1,
      id: "req-1",
      ok: false,
      error: "ERR_FORBIDDEN",
    });
    await runYoloCli(["on", "sess-1"]);
    assert.equal(process.exitCode, 1);
  });
});
