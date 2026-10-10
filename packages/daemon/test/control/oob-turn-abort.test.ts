import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { closeTestDb } from "../helpers/close-test-db";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { executeSessionAgentTurn } from "../../src/sessions/session-agent-turn";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { requestSessionTurnAbort, TurnAbortedError } from "../../src/sessions/session-turn-abort";
import {
  deliverOobStructuredResponse,
  deliverSubagentResult,
} from "../../src/control/integration-ops";
import type { SubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";
import { setSubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";
import { deliverTimerMessage } from "../../src/timers/timer-delivery";
import { getLogger } from "../../src/logging";

describe("OOB cancellation through the session core", () => {
  let db: Database.Database;
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "shoggoth-oob-abort-"));
    db = new Database(join(workspace, "state.db"));
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    setSubagentRuntimeExtension(undefined);
    vi.restoreAllMocks();
    await closeTestDb(db, workspace);
  });

  function harness(sessionId: string, attached: boolean, abortCall: number, throwOnError = false) {
    const config = defaultConfig(workspace);
    const sessions = createSessionStore(db);
    sessions.create({ id: sessionId, workspacePath: workspace });
    const session = sessions.getById(sessionId);
    if (!session) throw new Error("fixture session missing");
    const hitl = createHitlPendingResolutionStack(db);
    let calls = 0;
    const completeWithTools = vi.fn(async () => {
      calls += 1;
      if (calls === abortCall) {
        expect(requestSessionTurnAbort(sessionId)).toBe(true);
        expect(requestSessionTurnAbort(sessionId)).toBe(true);
        throw new TurnAbortedError();
      }
      return {
        content:
          calls < abortCall
            ? "malformed"
            : JSON.stringify({ to_operator: "recovered", to_sender: null }),
        toolCalls: [],
        usedProviderId: "fixture",
        usedModel: "fixture",
        degraded: false,
      };
    });
    const runSessionModelTurn: SubagentRuntimeExtension["runSessionModelTurn"] = (input) =>
      executeSessionAgentTurn({
        db,
        sessionId,
        session,
        transcript: createTranscriptStore(db),
        toolRuns: createToolRunStore(db),
        userContent: input.userContent,
        userMetadata: input.userMetadata,
        env: {},
        config,
        modelInvocationOverride: input.modelInvocationOverride,
        throwOnError,
        policyEngine: createPolicyEngine(config.policy),
        getHitlConfig: () => config.hitl,
        hitl: {
          bypassUpTo: "safe",
          pending: hitl.pending,
          clock: { nowMs: () => Date.now() },
          newPendingId: () => randomUUID(),
          waitForHitlResolution: hitl.waitForHitlResolution,
        },
        createToolCallingClient: () => ({ completeWithTools }),
        resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
      });
    const ext: SubagentRuntimeExtension = {
      runSessionModelTurn: vi.fn(runSessionModelTurn),
      postToOperator: vi.fn(),
      subscribeSubagentSession: () => () => {},
      registerPlatformThreadBinding: () => () => {},
      resolveOutboundChannelIdForSession: () => (attached ? "fixture-channel" : undefined),
    };
    return { ext, completeWithTools };
  }

  it.each([
    ["top-level", true],
    ["persistent-thread", true],
    ["unattached", false],
  ] as const)("does not repair an aborted initial turn (%s)", async (sessionId, attached) => {
    const { ext, completeWithTools } = harness(sessionId, attached, 1);
    const subLog = getLogger("oob-abort-test");
    const errors = vi.spyOn(subLog, "error");
    await deliverSubagentResult(ext, {
      respondTo: sessionId,
      childSessionId: "child",
      internalDelivery: true,
      mode: "persistent",
      deliveryMode: "queue",
      assistantText: "child result",
      subLog,
    });
    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(ext.postToOperator).toHaveBeenCalledTimes(attached ? 1 : 0);
    if (attached)
      expect(ext.postToOperator).toHaveBeenCalledWith({
        sessionId,
        userContent: expect.stringMatching(/out-of-band.*aborted/i),
      });
    expect(errors).not.toHaveBeenCalled();
    expect(requestSessionTurnAbort(sessionId)).toBe(false);
  });

  it.each([true, false])(
    "stops an aborted repair turn (attached=%s) and allows the next event",
    async (attached) => {
      const sessionId = "repair-session";
      const { ext, completeWithTools } = harness(sessionId, attached, 2);
      const subLog = getLogger("oob-repair-test");
      const errors = vi.spyOn(subLog, "error");
      const delivery = {
        respondTo: sessionId,
        childSessionId: "child",
        internalDelivery: true,
        mode: "persistent" as const,
        deliveryMode: "queue" as const,
        assistantText: "child result",
        subLog,
      };
      await deliverSubagentResult(ext, delivery);
      expect(completeWithTools).toHaveBeenCalledTimes(2);
      expect(errors).not.toHaveBeenCalled();
      expect(ext.postToOperator).toHaveBeenCalledTimes(attached ? 1 : 0);
      expect(requestSessionTurnAbort(sessionId)).toBe(false);
      await deliverSubagentResult(ext, delivery);
      expect(completeWithTools).toHaveBeenCalledTimes(3);
      expect(ext.postToOperator).toHaveBeenLastCalledWith({ sessionId, userContent: "recovered" });
    },
  );

  it("retains explicit cancellation even when partial text is valid OOB JSON", async () => {
    const { ext } = harness("partial-session", true, 1);
    // Spread keeps the test red on the pre-fix signature without a type assertion.
    const state = { aborted: true };
    await deliverOobStructuredResponse({
      ...state,
      structuredResponse: JSON.stringify({
        to_operator: "do not deliver",
        to_sender: "do not resume",
      }),
      respondTo: "partial-session",
      ext,
      subLog: getLogger("oob-partial-test"),
      hasSender: true,
    });
    expect(ext.runSessionModelTurn).not.toHaveBeenCalled();
    expect(ext.postToOperator).toHaveBeenCalledExactlyOnceWith({
      sessionId: "partial-session",
      userContent: expect.stringMatching(/out-of-band.*aborted/i),
    });
  });

  it.each([true, false])("stops an aborted timer turn (attached=%s)", async (attached) => {
    const { ext, completeWithTools } = harness("timer-session", attached, 1);
    setSubagentRuntimeExtension(ext);
    await deliverTimerMessage("timer-session", "timer fired");
    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(ext.postToOperator).toHaveBeenCalledTimes(attached ? 1 : 0);
    expect(ext.runSessionModelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userMetadata: { timer_fire: true },
        delivery: { kind: "internal" },
        modelInvocationOverride: expect.objectContaining({ responseSchema: expect.any(Object) }),
      }),
    );
  });

  it("stops a cancelled timer repair and successfully handles a later timer", async () => {
    const { ext, completeWithTools } = harness("timer-repair", true, 2);
    setSubagentRuntimeExtension(ext);
    await deliverTimerMessage("timer-repair", "first timer");
    expect(completeWithTools).toHaveBeenCalledTimes(2);
    expect(ext.postToOperator).toHaveBeenCalledExactlyOnceWith({
      sessionId: "timer-repair",
      userContent: expect.stringMatching(/out-of-band.*aborted/i),
    });
    await deliverTimerMessage("timer-repair", "second timer");
    expect(completeWithTools).toHaveBeenCalledTimes(3);
    expect(ext.postToOperator).toHaveBeenLastCalledWith({
      sessionId: "timer-repair",
      userContent: "recovered",
    });
  });

  it("does not turn a failed abort notice into a repair failure", async () => {
    const { ext, completeWithTools } = harness("notice-session", true, 2);
    vi.mocked(ext.postToOperator!).mockRejectedValue(new Error("surface offline"));
    const subLog = getLogger("oob-notice-test");
    const errors = vi.spyOn(subLog, "error");
    await deliverSubagentResult(ext, {
      respondTo: "notice-session",
      childSessionId: "child",
      internalDelivery: true,
      mode: "persistent",
      deliveryMode: "queue",
      assistantText: "child result",
      subLog,
    });
    expect(completeWithTools).toHaveBeenCalledTimes(2);
    expect(ext.postToOperator).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("preserves cancellation exceptions for workflow callers", async () => {
    const { ext } = harness("workflow-session", false, 1, true);
    await expect(
      ext.runSessionModelTurn({
        sessionId: "workflow-session",
        userContent: "work",
        delivery: { kind: "internal" },
      }),
    ).rejects.toBeInstanceOf(TurnAbortedError);
    expect(requestSessionTurnAbort("workflow-session")).toBe(false);
  });

  it("preserves partial text and reports cancellation as state from the real session core", async () => {
    const { ext } = harness("core-state", false, 1);
    const result = await ext.runSessionModelTurn({
      sessionId: "core-state",
      userContent: "event",
      delivery: { kind: "internal" },
    });
    expect(result).toMatchObject({
      aborted: true,
      latestAssistantText: expect.stringContaining("<Aborted>"),
    });
    expect(requestSessionTurnAbort("core-state")).toBe(false);
  });

  it("honors cancellation even if a runtime extension has no partial text", async () => {
    const { ext } = harness("empty-abort", true, 1);
    vi.mocked(ext.runSessionModelTurn).mockResolvedValue({
      latestAssistantText: "",
      failoverMeta: undefined,
      aborted: true,
    });
    setSubagentRuntimeExtension(ext);
    await deliverTimerMessage("empty-abort", "event");
    expect(ext.runSessionModelTurn).toHaveBeenCalledTimes(1);
    expect(ext.postToOperator).toHaveBeenCalledExactlyOnceWith({
      sessionId: "empty-abort",
      userContent: expect.stringMatching(/out-of-band.*aborted/i),
    });
  });
});
