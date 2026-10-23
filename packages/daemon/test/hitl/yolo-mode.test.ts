import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createYoloModeStore } from "../../src/hitl/yolo-mode-store";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";
import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  return db;
}

describe("yolo mode store", () => {
  it("round-trips: off by default, on after setEnabled, off after clearing", () => {
    const db = migratedDb();
    try {
      const store = createYoloModeStore(db);
      const sessionId = "agent:main:discord:channel:yolo-1";

      assert.equal(store.isEnabled(sessionId), false);
      assert.deepEqual(store.getStatus(sessionId), { enabled: false });

      store.setEnabled(sessionId, true);
      assert.equal(store.isEnabled(sessionId), true);
      const on = store.getStatus(sessionId);
      assert.equal(on.enabled, true);
      assert.ok(on.updatedAt, "enabled status carries updated_at");

      store.setEnabled(sessionId, false);
      assert.equal(store.isEnabled(sessionId), false);
      assert.deepEqual(store.getStatus(sessionId), { enabled: false });
    } finally {
      db.close();
    }
  });

  it("stays enabled for its lifetime: repeated on calls do not toggle it off", () => {
    const db = migratedDb();
    try {
      const store = createYoloModeStore(db);
      const sessionId = "agent:main:discord:channel:yolo-2";
      store.setEnabled(sessionId, true);
      store.setEnabled(sessionId, true);
      assert.equal(store.isEnabled(sessionId), true);

      const otherSession = "agent:main:discord:channel:yolo-other";
      assert.equal(store.isEnabled(otherSession), false);
      store.setEnabled(sessionId, false);
      assert.equal(store.isEnabled(sessionId), false);
      assert.equal(store.isEnabled(otherSession), false);
    } finally {
      db.close();
    }
  });
});

describe("tool loop yolo mode gate", () => {
  const TOOL_RISK = {
    "builtin-read": "safe",
    "builtin-write": "caution",
    "builtin-exec": "critical",
  } as const;

  function buildHarness(sessionId: string): {
    db: Database.Database;
    runToolLoopOnce: (opts: {
      yoloActive?: (id: string) => boolean;
      onQueued?: (row: { id: string }) => void;
      approveOnQueue?: boolean;
    }) => Promise<{ execCount: number }>;
  } {
    const db = migratedDb();
    createSessionStore(db).create({ id: sessionId, workspacePath: `/w/${sessionId}` });
    const hitlStack = createHitlPendingResolutionStack(db);
    const engine = createPolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { ...DEFAULT_POLICY_CONFIG.agent.tools, allow: ["*"], deny: [] },
      },
    });
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId,
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "run-yolo",
    });
    const toolRuns = createToolRunStore(db);

    return {
      db,
      async runToolLoopOnce({ yoloActive, onQueued, approveOnQueue }) {
        let modelTurn = 0;
        const toolMsgs: { toolCallId: string; content: string }[] = [];
        let execCount = 0;
        const model = {
          async complete() {
            if (modelTurn++ === 0) {
              return {
                content: null,
                toolCalls: [{ id: "w1", name: "builtin-exec", argsJson: "{}" }],
              };
            }
            return { content: "ok", toolCalls: [] };
          },
          pushToolMessage(input: { toolCallId: string; content: string }) {
            toolMsgs.push(input);
          },
        };

        await runToolLoop({
          db,
          sessionId,
          runId: `run-yolo-${modelTurn}`,
          principalId: sessionId,
          policy,
          audit,
          model,
          tools: [{ name: "builtin-exec" }],
          executor: {
            execute: async () => {
              execCount++;
              return { resultJson: '{"ok":true}' };
            },
          },
          toolRuns,
          hitl: {
            config: {
              defaultApprovalTimeoutMs: 300_000,
              toolRisk: { ...TOOL_RISK },
              bypassUpTo: "safe",
            },
            bypassUpTo: "safe",
            pending: hitlStack.pending,
            clock: { nowMs: () => Date.now() },
            newPendingId: () => `pend-yolo-${modelTurn}`,
            waitForHitlResolution: hitlStack.waitForHitlResolution,
            ...(yoloActive ? { yoloActive } : {}),
            hitlNotifier: {
              onQueued(row) {
                onQueued?.(row);
                if (approveOnQueue) {
                  queueMicrotask(() => {
                    hitlStack.pending.approve(row.id, "test-operator");
                  });
                }
              },
            },
          },
        });

        return { execCount };
      },
    };
  }

  it("auto-executes a critical-tier tool when yolo is active (no pending row)", async () => {
    const sessionId = "sess-yolo-on";
    const harness = buildHarness(sessionId);
    try {
      let notified = 0;
      const { execCount } = await harness.runToolLoopOnce({
        yoloActive: (id) => id === sessionId,
        onQueued: () => {
          notified++;
        },
      });
      assert.equal(execCount, 1, "critical tool executed without operator approval");
      assert.equal(notified, 0, "no HITL row was enqueued");
      const rows = harness.db
        .prepare(`SELECT id FROM hitl_pending_actions WHERE session_id = ?`)
        .all(sessionId);
      assert.equal(rows.length, 0, "no pending HITL rows for the session");
    } finally {
      harness.db.close();
    }
  });

  it("queues the same call for HITL without yolo mode", async () => {
    const sessionId = "sess-yolo-off";
    const harness = buildHarness(sessionId);
    try {
      let queuedCount = 0;
      const { execCount } = await harness.runToolLoopOnce({
        yoloActive: () => false,
        approveOnQueue: true,
        onQueued: () => {
          queuedCount++;
        },
      });
      assert.equal(queuedCount, 1, "one HITL row enqueued without yolo mode");
      assert.equal(execCount, 1, "tool executes after operator approval");
      const rows = harness.db
        .prepare(`SELECT status FROM hitl_pending_actions WHERE session_id = ?`)
        .all(sessionId) as { status: string }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "approved");
    } finally {
      harness.db.close();
    }
  });
});
