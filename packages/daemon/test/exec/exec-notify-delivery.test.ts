import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert";
import {
  buildExecNotifyResult,
  deliverExecNotifyMessage,
} from "../../src/exec/exec-notify-delivery";
import type { ExecNotifyCompletion, ExecNotifyHandle } from "../../src/exec/exec-notify-scheduler";
import {
  registerSteerChannel,
  drainSteers,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";
import {
  registerActiveTurnSurface,
  _resetActiveTurnSurfaces,
} from "../../src/presentation/active-turn-surface";
import { setSubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";

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

describe("deliverExecNotifyMessage in-turn delivery", () => {
  afterEach(() => {
    _resetAllChannels();
    _resetActiveTurnSurfaces();
    setSubagentRuntimeExtension(undefined);
  });

  const completion: ExecNotifyCompletion = {
    handle: {
      id: "n1",
      sessionId: "sess-1",
      execSessionId: "exec-1",
      pid: 4242,
      command: "echo hi",
      options: {},
    },
    exitCode: 0,
    signal: null,
    stdout: "hi",
  };

  it("injects into the steer channel when a turn is active — no OOB turn", async () => {
    const runSessionModelTurn = vi.fn();
    setSubagentRuntimeExtension({ runSessionModelTurn } as never);
    const { unregister } = registerSteerChannel("sess-1");

    await deliverExecNotifyMessage(completion);

    const msgs = drainSteers("sess-1");
    assert.equal(msgs.length, 1);
    // Emoji-lead blockquote banner with the payload body underneath
    assert.ok(msgs[0].startsWith("> ↩️ Exec notification: *echo hi* `n1`"), msgs[0]);
    assert.ok(msgs[0].includes('"kind": "exec.notify"'), msgs[0]);
    assert.ok(msgs[0].includes('"exitCode": 0'), msgs[0]);
    assert.ok(msgs[0].includes('"output": "hi"'), msgs[0]);
    assert.equal(runSessionModelTurn.mock.calls.length, 0);
    unregister();
  });

  it("posts a standalone surface banner only when no turn surface is registered", async () => {
    const statusMessages: string[] = [];
    setSubagentRuntimeExtension({
      runSessionModelTurn: vi.fn(),
      sendStatusMessage: async (_sessionId: string, body: string) => {
        statusMessages.push(body);
      },
    } as never);
    const { unregister } = registerSteerChannel("sess-1");

    await deliverExecNotifyMessage(completion);

    assert.equal(drainSteers("sess-1").length, 1);
    assert.equal(statusMessages.length, 1);
    assert.ok(
      statusMessages[0]!.startsWith("> ↩️ ✅ Exec notification delivered in-turn"),
      statusMessages[0],
    );
    assert.ok(statusMessages[0]!.includes("`n1`"), statusMessages[0]);
    unregister();
  });

  it("folds the delivery banner into the active turn surface instead of posting", async () => {
    const statusMessages: string[] = [];
    const notices: string[] = [];
    setSubagentRuntimeExtension({
      runSessionModelTurn: vi.fn(),
      sendStatusMessage: async (_sessionId: string, body: string) => {
        statusMessages.push(body);
      },
    } as never);
    const { unregister } = registerSteerChannel("sess-1");
    const surface = registerActiveTurnSurface("sess-1", {
      captureAnchor: () => ({ committedProseSegments: 0, toolCalls: 0 }),
      onNotice: (notice) => {
        notices.push(notice);
      },
    });

    await deliverExecNotifyMessage(completion);

    assert.equal(drainSteers("sess-1").length, 1);
    assert.equal(statusMessages.length, 0, "no standalone message while a turn surface exists");
    assert.equal(notices.length, 1);
    assert.ok(notices[0]!.startsWith("> ↩️ ✅ Exec notification delivered in-turn"), notices[0]);
    assert.ok(notices[0]!.includes("`n1`"), notices[0]);
    surface.unregister();
    unregister();
  });

  it("falls back to an OOB turn when no turn is active", async () => {
    const runSessionModelTurn = vi.fn().mockResolvedValue({ latestAssistantText: "" });
    setSubagentRuntimeExtension({ runSessionModelTurn } as never);

    await deliverExecNotifyMessage(completion);

    assert.equal(runSessionModelTurn.mock.calls.length, 1);
    const call = runSessionModelTurn.mock.calls[0][0];
    assert.equal(call.sessionId, "sess-1");
    assert.equal(call.userMetadata.exec_notify, true);
  });

  it("falls back to an OOB turn when the in-turn delivery is dropped by turn end", async () => {
    const runSessionModelTurn = vi.fn().mockResolvedValue({ latestAssistantText: "" });
    setSubagentRuntimeExtension({ runSessionModelTurn } as never);
    const { unregister } = registerSteerChannel("sess-1");

    await deliverExecNotifyMessage(completion);
    // Turn ended before the steer was drained — the drop callback must
    // deliver OOB so the notification is never lost.
    assert.equal(runSessionModelTurn.mock.calls.length, 0);
    unregister();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(runSessionModelTurn.mock.calls.length, 1);
    assert.equal(runSessionModelTurn.mock.calls[0][0].userMetadata.exec_notify, true);
  });
});
