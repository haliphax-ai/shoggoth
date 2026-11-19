/**
 * Timer delivery retargeting: a timer owned by a terminated one-shot subagent
 * but anchored to its still-live parent delivers to the anchor instead of
 * dying on the owner row (the platform turn guard would reject the terminated
 * owner and the anchored session would silently never hear the wake-up).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { bindIntegrationOpsSessionStore } from "../../src/control/ops-shared";
import { resolveTimerDeliveryTarget } from "../../src/timers/timer-delivery";
import type { SubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";
import { setSubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";
import { deliverTimerMessage } from "../../src/timers/timer-delivery";

describe("timer delivery retargeting", () => {
  let db: Database.Database;
  let workspace: string;
  let ownerSessionId: string;
  let anchorSessionId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "shoggoth-timer-retarget-"));
    db = new Database(join(workspace, "state.db"));
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    anchorSessionId = "agent:dev:discord:channel:00000000-0000-0000-0000-000000000001";
    ownerSessionId = "agent:dev:discord:channel:00000000-0000-0000-0000-000000000002";
    sessions.create({ id: anchorSessionId, workspacePath: workspace, status: "active" });
    sessions.create({ id: ownerSessionId, workspacePath: workspace, status: "active" });
    sessions.update(ownerSessionId, { parentSessionId: anchorSessionId });
    bindIntegrationOpsSessionStore(sessions);
  });

  afterEach(async () => {
    setSubagentRuntimeExtension(undefined);
    bindIntegrationOpsSessionStore(undefined as never);
    vi.restoreAllMocks();
    await closeTestDb(db, workspace);
  });

  describe("resolveTimerDeliveryTarget", () => {
    it("retargets a terminated owner's timer to its live anchor", () => {
      const sessions = createSessionStore(db);
      sessions.update(ownerSessionId, { status: "terminated" });
      const target = resolveTimerDeliveryTarget({
        sessionId: ownerSessionId,
        sessionAnchor: anchorSessionId,
      });
      expect(target).toBe(anchorSessionId);
    });

    it("keeps the owner when it is still active", () => {
      const target = resolveTimerDeliveryTarget({
        sessionId: ownerSessionId,
        sessionAnchor: anchorSessionId,
      });
      expect(target).toBe(ownerSessionId);
    });

    it("keeps the owner when no anchor is set", () => {
      const sessions = createSessionStore(db);
      sessions.update(ownerSessionId, { status: "terminated" });
      const target = resolveTimerDeliveryTarget({ sessionId: ownerSessionId });
      expect(target).toBe(ownerSessionId);
    });

    it("keeps the owner when the anchor is also terminated", () => {
      const sessions = createSessionStore(db);
      sessions.update(ownerSessionId, { status: "terminated" });
      sessions.update(anchorSessionId, { status: "terminated" });
      const target = resolveTimerDeliveryTarget({
        sessionId: ownerSessionId,
        sessionAnchor: anchorSessionId,
      });
      expect(target).toBe(ownerSessionId);
    });

    it("keeps the owner when the anchor equals the owner", () => {
      const sessions = createSessionStore(db);
      sessions.update(ownerSessionId, { status: "terminated" });
      const target = resolveTimerDeliveryTarget({
        sessionId: ownerSessionId,
        sessionAnchor: ownerSessionId,
      });
      expect(target).toBe(ownerSessionId);
    });
  });

  describe("deliverTimerMessage with a terminated owner", () => {
    it("runs the timer turn on the anchor session, not the dead owner", async () => {
      const sessions = createSessionStore(db);
      sessions.update(ownerSessionId, { status: "terminated" });
      const turnSessionIds: string[] = [];
      const ext: SubagentRuntimeExtension = {
        runSessionModelTurn: (async (input: { sessionId: string }) => {
          turnSessionIds.push(input.sessionId);
          return {
            latestAssistantText: JSON.stringify({ to_operator: "wake up" }),
            failoverMeta: undefined,
            aborted: false,
            outcome: "completed",
          } as never;
        }) as never,
        postToOperator: vi.fn(),
        subscribeSubagentSession: () => () => {},
        registerPlatformThreadBinding: () => () => {},
        announcePersistentSubagentSessionEnded: () => {},
      };
      setSubagentRuntimeExtension(ext);
      await deliverTimerMessage({
        id: "timer-1",
        sessionId: ownerSessionId,
        label: "check-in",
        fireAt: new Date().toISOString(),
        message: "check on the push",
        sessionAnchor: anchorSessionId,
      });
      expect(turnSessionIds).toEqual([anchorSessionId]);
      expect(ext.postToOperator).toHaveBeenCalledWith({
        sessionId: anchorSessionId,
        userContent: "wake up",
      });
    });

    it("still runs on the owner when it is alive (no retarget)", async () => {
      const config = defaultConfig(workspace);
      const hitl = createHitlPendingResolutionStack(db);
      const sessions = createSessionStore(db);
      const runSessionModelTurn: SubagentRuntimeExtension["runSessionModelTurn"] = (input) =>
        executeSessionAgentTurn({
          db,
          sessionId: input.sessionId,
          session: sessions.getById(input.sessionId)!,
          transcript: createTranscriptStore(db),
          toolRuns: createToolRunStore(db),
          userContent: input.userContent,
          userMetadata: input.userMetadata,
          env: {},
          config,
          modelInvocationOverride: input.modelInvocationOverride,
          policyEngine: createPolicyEngine(config.policy),
          getHitlConfig: () => config.hitl,
          hitl: {
            bypassUpTo: "safe",
            pending: hitl.pending,
            clock: { nowMs: () => Date.now() },
            newPendingId: () => `${Date.now()}-${Math.random()}`,
            waitForHitlResolution: hitl.waitForHitlResolution,
          },
          createToolCallingClient: () => ({
            completeWithTools: async () => ({
              content: JSON.stringify({ to_operator: "done" }),
              toolCalls: [],
              usedProviderId: "fixture",
              usedModel: "fixture",
              degraded: false,
            }),
          }),
          resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
        });
      const ext: SubagentRuntimeExtension = {
        runSessionModelTurn: runSessionModelTurn,
        postToOperator: vi.fn(),
        subscribeSubagentSession: () => () => {},
        registerPlatformThreadBinding: () => () => {},
        announcePersistentSubagentSessionEnded: () => {},
      };
      setSubagentRuntimeExtension(ext);
      await deliverTimerMessage({
        id: "timer-2",
        sessionId: ownerSessionId,
        label: "live",
        fireAt: new Date().toISOString(),
        message: "fire on the owner",
        sessionAnchor: anchorSessionId,
      });
      // The turn ran on the live owner: its transcript carries the reply.
      const row = sessions.getById(ownerSessionId)!;
      const page = createTranscriptStore(db).listPage({
        sessionId: ownerSessionId,
        contextSegmentId: row.contextSegmentId,
        afterSeq: 0,
        limit: 50,
      });
      expect(page.messages.some((m) => m.role === "assistant")).toBe(true);
    });
  });
});
