import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the daemon control client before importing the module under test
vi.mock("@shoggoth/daemon/lib", () => ({ invokeControlRequest: vi.fn() }));

import { invokeControlRequest } from "@shoggoth/daemon/lib";
import { runQueueCli } from "../src/run-queue";

const mockInvoke = vi.mocked(invokeControlRequest);

const origExitCode = process.exitCode;

describe("run-queue CLI --range validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ ok: true, result: { removed: 0 } } as never);
    process.exitCode = undefined;
    process.env.SHOGGOTH_CONTROL_SOCKET = "/tmp/test-socket";
    process.env.SHOGGOTH_OPERATOR_TOKEN = "test-token";
  });

  afterEach(() => {
    process.exitCode = origExitCode;
    delete process.env.SHOGGOTH_CONTROL_SOCKET;
    delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  });

  it("sends a valid range to the daemon as start/end", async () => {
    await runQueueCli(["remove", "--session", "s1", "--range", "3-7"]);

    expect(mockInvoke).toHaveBeenCalledWith({
      socketPath: "/tmp/test-socket",
      auth: { kind: "operator_token", token: "test-token" },
      op: "session_queue_manage",
      payload: { session_id: "s1", action: "remove", by: "range", start: 3, end: 7 },
    });
    expect(process.exitCode).not.toBe(1);
  });

  const invalidRanges = ["abc", "1-2-3", "5", "1-x", "3-"];

  for (const range of invalidRanges) {
    it(`rejects malformed --range "${range}"`, async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await runQueueCli(["remove", "--session", "s1", "--range", range]);

      expect(errSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls.some((c) => String(c[0]).startsWith("error:"))).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(mockInvoke).not.toHaveBeenCalled();

      errSpy.mockRestore();
    });
  }
});
