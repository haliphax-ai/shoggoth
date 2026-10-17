import { describe, it } from "vitest";
import assert from "node:assert";
import { buildExecNotifyResult } from "../../src/exec/exec-notify-delivery";
import type { ExecNotifyCompletion, ExecNotifyHandle } from "../../src/exec/exec-notify-scheduler";

function completion(
  options: ExecNotifyHandle["options"] = {},
  out: { stdout?: string; stderr?: string; exitCode?: number | null } = {},
  lost = false,
): ExecNotifyCompletion {
  return {
    handle: {
      id: "n1",
      sessionId: "sess-1",
      execSessionId: "exec-1",
      pid: 4242,
      command: "echo hi",
      options,
    },
    exitCode: out.exitCode !== undefined ? out.exitCode : 0,
    signal: null,
    ...(out.stdout !== undefined ? { stdout: out.stdout } : {}),
    ...(out.stderr !== undefined ? { stderr: out.stderr } : {}),
    ...(lost ? { lost: true } : {}),
  };
}

describe("buildExecNotifyResult", () => {
  it("always carries identity and the exit code", () => {
    const r = buildExecNotifyResult(completion({}, { exitCode: 42, stdout: "hi" }));
    assert.equal(r.kind, "exec.notify");
    assert.equal(r.notifyId, "n1");
    assert.equal(r.execSessionId, "exec-1");
    assert.equal(r.pid, 4242);
    assert.equal(r.exitCode, 42);
    assert.equal(r.signal, null);
  });

  it("combines streams by default, honoring maxOutput and tail truncation", () => {
    const r = buildExecNotifyResult(
      completion({ maxOutput: 10, truncation: "tail" }, { stdout: "aaa", stderr: "bbbbbbbbbbb" }),
    );
    assert.ok(typeof r.output === "string");
    assert.ok((r.output as string).length <= 120); // 10 chars + truncation marker
    assert.equal(r.truncated, true);
    assert.equal(r.stdout, undefined);
    assert.equal(r.stderr, undefined);
  });

  it("splits streams when splitStreams was set", () => {
    const r = buildExecNotifyResult(
      completion({ splitStreams: true }, { stdout: "out", stderr: "err" }),
    );
    assert.equal(r.stdout, "out");
    assert.equal(r.stderr, "err");
    assert.equal(r.output, undefined);
  });

  it("returns only the path for outputFile", () => {
    const r = buildExecNotifyResult(
      completion({ outputFile: "tmp/o.txt" }, { stdout: "streamed" }),
    );
    assert.equal(r.outputFile, "tmp/o.txt");
    assert.equal(r.output, undefined);
    assert.equal(r.stdout, undefined);
  });

  it("returns paths for redirected streams and inline content for the rest", () => {
    const r = buildExecNotifyResult(
      completion(
        { stdoutFile: "tmp/out.txt", splitStreams: true },
        { stdout: "streamed", stderr: "inline-err" },
      ),
    );
    assert.equal(r.stdoutFile, "tmp/out.txt");
    assert.equal(r.stdout, undefined);
    assert.equal(r.stderr, "inline-err");
  });

  it("marks lost completions with an unknown exit code and a note", () => {
    const r = buildExecNotifyResult(completion({}, { exitCode: null }, true));
    assert.equal(r.exitCode, null);
    assert.equal(r.lost, true);
    assert.ok(typeof r.note === "string");
    assert.equal(r.output, undefined);
  });
});
