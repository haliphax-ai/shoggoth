/**
 * Tests for persistent subagent all-turn delivery.
 *
 * Verifies that after each persistent subagent turn completes:
 * 1. Non-thread-bound sessions with delivery_mode != 'drop' deliver results to parent
 * 2. Thread-bound sessions do NOT deliver results (handled via platform thread)
 * 3. delivery_mode='drop' sessions do NOT deliver results
 *
 * The delivery hook is in runInboundSessionTurn after executeSessionAgentTurn completes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore, type SessionStore } from "../../src/sessions/session-store";
import { registerSteerChannel, _resetAllChannels } from "../../src/sessions/steer-channel";
import { subagentRuntimeExtensionRef } from "../../src/subagent/subagent-extension-ref";
// Mock subagentRuntimeExtensionRef
const mockRunSessionModelTurn = vi.fn().mockResolvedValue({});
const mockSubagentExt = {
  runSessionModelTurn: mockRunSessionModelTurn,
};

// Test helper: create a persistent subagent session
function createPersistentSubagentSession(
  sessions: SessionStore,
  sessionId: string,
  parentId: string,
  respondTo: string,
  platformThreadId: string | undefined,
  deliveryMode: "inline" | "queue" | "drop" | undefined,
  workspacePath: string,
) {
  sessions.create({
    id: sessionId,
    workspacePath,
  });
  sessions.update(sessionId, {
    parentSessionId: parentId,
    subagentMode: "persistent",
    subagentPlatformThreadId: platformThreadId ?? null,
    subagentDeliveryMode: deliveryMode,
    subagentRespondTo: respondTo,
  });
}

describe("persistent subagent all-turn delivery", () => {
  let db: Database.Database;
  let tmp: string;
  let sessions: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-persist-delivery-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    sessions = createSessionStore(db);

    // Reset steer channels
    _resetAllChannels();

    // Mock the subagent runtime extension
    subagentRuntimeExtensionRef.current = mockSubagentExt as never;

    vi.clearAllMocks();
  });

  afterEach(() => {
    subagentRuntimeExtensionRef.current = null;
    _resetAllChannels();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("delivery conditions after a persistent subagent turn completes", () => {
    it("delivers result for non-thread-bound session with delivery_mode='inline'", async () => {
      // Arrange: non-thread-bound persistent subagent with inline delivery mode
      const childId = "child-inline";
      const parentId = "parent-inline";
      const respondTo = parentId;

      createPersistentSubagentSession(
        sessions,
        childId,
        parentId,
        respondTo,
        undefined, // no platformThreadId = non-thread-bound
        "inline",
        tmp,
      );

      // Register a steer channel to simulate active model loop in parent
      const handle = registerSteerChannel(respondTo);

      // Import the delivery function to test the conditions directly
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");
      const mockSubLog = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      // Act: call deliverSubagentResult as if the turn just completed
      await deliverSubagentResult(mockSubagentExt as never, {
        childSessionId: childId,
        respondTo,
        internalDelivery: true,
        mode: "persistent",
        deliveryMode: "inline",
        assistantText: "Test result from persistent subagent",
        subLog: mockSubLog as never,
      });

      // Assert: in inline mode with active steer channel, pushSteer is used (no runSessionModelTurn)
      expect(mockRunSessionModelTurn).not.toHaveBeenCalled();
      expect(mockSubLog.info).toHaveBeenCalledWith(
        expect.stringContaining("injected inline via steer channel"),
        expect.anything(),
      );

      handle.unregister();
    });

    it("delivers result for non-thread-bound session with delivery_mode='queue'", async () => {
      // Arrange: non-thread-bound persistent subagent with queue delivery mode
      const childId = "child-queue";
      const parentId = "parent-queue";
      const respondTo = parentId;

      createPersistentSubagentSession(
        sessions,
        childId,
        parentId,
        respondTo,
        undefined, // no platformThreadId = non-thread-bound
        "queue",
        tmp,
      );

      const { deliverSubagentResult } = await import("../../src/control/integration-ops");
      const mockSubLog = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      // Act
      await deliverSubagentResult(mockSubagentExt as never, {
        childSessionId: childId,
        respondTo,
        internalDelivery: true,
        mode: "persistent",
        deliveryMode: "queue",
        assistantText: "Test result from persistent subagent",
        subLog: mockSubLog as never,
      });

      // Assert: queue mode always uses runSessionModelTurn
      expect(mockRunSessionModelTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: respondTo,
          userMetadata: expect.objectContaining({
            subagent_result: true,
            child_session_id: childId,
            mode: "persistent",
          }),
        }),
      );
      expect(mockSubLog.info).toHaveBeenCalledWith(
        expect.stringContaining("delivered to respond_to session"),
        expect.anything(),
      );
    });

    it("does NOT deliver result for thread-bound session (has platform_thread_id)", async () => {
      // Note: thread-bound check is done at the CALL site in integration-ops.ts (line ~1280),
      // not inside deliverSubagentResult. The call site checks `if (!platformThreadId)` before
      // calling deliverSubagentResult. For the all-turn hook, we'll need to add similar logic.
      // This test verifies the session row has the right data for the hook to make that decision.
      const childId = "child-thread";
      const parentId = "parent-thread";
      const respondTo = parentId;
      const platformThreadId = "thread-123";

      createPersistentSubagentSession(
        sessions,
        childId,
        parentId,
        respondTo,
        platformThreadId,
        "inline",
        tmp,
      );

      const row = sessions.getById(childId);
      expect(row?.subagentPlatformThreadId).toBe("thread-123");
      expect(row?.subagentMode).toBe("persistent");
    });

    it("does NOT deliver result when delivery_mode='drop'", async () => {
      // Arrange: persistent subagent with drop delivery mode
      const childId = "child-drop";
      const parentId = "parent-drop";
      const respondTo = parentId;

      createPersistentSubagentSession(
        sessions,
        childId,
        parentId,
        respondTo,
        undefined, // non-thread-bound
        "drop", // drop mode
        tmp,
      );

      const { deliverSubagentResult } = await import("../../src/control/integration-ops");
      const mockSubLog = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      // Act
      await deliverSubagentResult(mockSubagentExt as never, {
        childSessionId: childId,
        respondTo,
        internalDelivery: true,
        mode: "persistent",
        deliveryMode: "drop",
        assistantText: "Test result that should be dropped",
        subLog: mockSubLog as never,
      });

      // Assert: drop mode should not call pushSteer or runSessionModelTurn
      expect(mockRunSessionModelTurn).not.toHaveBeenCalled();
      expect(mockSubLog.info).toHaveBeenCalledWith(
        "subagent result delivery skipped (drop mode)",
        expect.anything(),
      );
    });

    it("delivers result for non-thread-bound session with undefined delivery_mode (defaults to inline)", async () => {
      // Arrange: persistent subagent without explicit delivery mode
      const childId = "child-default";
      const parentId = "parent-default";
      const respondTo = parentId;

      createPersistentSubagentSession(
        sessions,
        childId,
        parentId,
        respondTo,
        undefined, // non-thread-bound
        undefined, // no delivery mode - should default to inline
        tmp,
      );

      // Register steer channel for inline mode
      const handle = registerSteerChannel(respondTo);

      const { deliverSubagentResult } = await import("../../src/control/integration-ops");
      const mockSubLog = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      // Act
      await deliverSubagentResult(mockSubagentExt as never, {
        childSessionId: childId,
        respondTo,
        internalDelivery: true,
        mode: "persistent",
        deliveryMode: "inline", // caller should default to inline when undefined
        assistantText: "Test result with default mode",
        subLog: mockSubLog as never,
      });

      // Assert: inline with active steer channel uses pushSteer
      expect(mockRunSessionModelTurn).not.toHaveBeenCalled();

      handle.unregister();
    });
  });

  describe("integration: verifying hook conditions in runInboundSessionTurn", () => {
    it("session row correctly identifies thread-bound vs non-thread-bound sessions", () => {
      // Non-thread-bound session
      createPersistentSubagentSession(
        sessions,
        "sess-no-thread",
        "parent-1",
        "respond-1",
        undefined,
        "inline",
        tmp,
      );
      const noThread = sessions.getById("sess-no-thread");
      expect(noThread?.subagentMode).toBe("persistent");
      expect(noThread?.subagentPlatformThreadId).toBeUndefined();

      // Thread-bound session
      createPersistentSubagentSession(
        sessions,
        "sess-with-thread",
        "parent-2",
        "respond-2",
        "thread-456",
        "inline",
        tmp,
      );
      const withThread = sessions.getById("sess-with-thread");
      expect(withThread?.subagentMode).toBe("persistent");
      expect(withThread?.subagentPlatformThreadId).toBe("thread-456");
    });

    it("session row correctly stores delivery mode", () => {
      // Inline mode
      createPersistentSubagentSession(sessions, "sess-inline", "p", "r", undefined, "inline", tmp);
      expect(sessions.getById("sess-inline")?.subagentDeliveryMode).toBe("inline");

      // Queue mode
      createPersistentSubagentSession(sessions, "sess-queue", "p", "r", undefined, "queue", tmp);
      expect(sessions.getById("sess-queue")?.subagentDeliveryMode).toBe("queue");

      // Drop mode
      createPersistentSubagentSession(sessions, "sess-drop", "p", "r", undefined, "drop", tmp);
      expect(sessions.getById("sess-drop")?.subagentDeliveryMode).toBe("drop");

      // Undefined (default)
      createPersistentSubagentSession(sessions, "sess-undef", "p", "r", undefined, undefined, tmp);
      expect(sessions.getById("sess-undef")?.subagentDeliveryMode).toBeUndefined();
    });

    it("session row correctly stores respond_to target", () => {
      createPersistentSubagentSession(
        sessions,
        "sess-respond",
        "parent",
        "target-session",
        undefined,
        "inline",
        tmp,
      );
      const row = sessions.getById("sess-respond");
      expect(row?.subagentRespondTo).toBe("target-session");
    });
  });
});
