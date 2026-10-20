import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import assert from "node:assert";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import {
  _resetActiveTurnSurfaces,
  registerActiveTurnSurface,
} from "../../src/presentation/active-turn-surface";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";
import type { CruiseControlDecision } from "@shoggoth/shared";

const HITL_CONFIG = {
  defaultApprovalTimeoutMs: 30_000,
  toolRisk: {
    "builtin-read": "safe",
    "builtin-write": "caution",
    "builtin-exec": "critical",
  },
  bypassUpTo: "safe",
} as const;

interface LoopHarness {
  db: Database.Database;
  options: Parameters<typeof runToolLoop>[0];
  execCount: () => number;
  toolMsgs: { toolCallId: string; content: string }[];
  queuedNotifier: { onQueued: (row: { id: string }) => void }[];
}

function makeHarness(sessionId: string, verdicts: CruiseControlDecision[]): LoopHarness {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  createSessionStore(db).create({ id: sessionId, workspacePath: `/w/${sessionId}` });
  const hitlStack = createHitlPendingResolutionStack(db);
  const engine = createPolicyEngine({
    ...DEFAULT_POLICY_CONFIG,
    agent: {
      ...DEFAULT_POLICY_CONFIG.agent,
      tools: { allow: ["*"], deny: [] },
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
    correlationId: `run-${sessionId}`,
  });
  const toolRuns = createToolRunStore(db);
  let modelTurn = 0;
  const toolMsgs: { toolCallId: string; content: string }[] = [];
  let execCount = 0;
  const judgeCalls: string[] = [];
  const queuedNotifier: { onQueued: (row: { id: string }) => void }[] = [];
  const model = {
    async complete() {
      if (modelTurn++ === 0) {
        return {
          content: null,
          toolCalls: [{ id: "w1", name: "builtin-write", argsJson: "{}" }],
        };
      }
      return { content: "ok", toolCalls: [] };
    },
    pushToolMessage(input: { toolCallId: string; content: string }) {
      toolMsgs.push(input);
    },
  };

  const options = {
    db,
    sessionId,
    runId: "run-1",
    principalId: sessionId,
    policy,
    audit,
    model,
    tools: [{ name: "builtin-write" }],
    executor: {
      execute: async () => {
        execCount++;
        return { resultJson: '{"ok":true}' };
      },
    },
    toolRuns,
    hitl: {
      config: {
        defaultApprovalTimeoutMs: HITL_CONFIG.defaultApprovalTimeoutMs,
        toolRisk: { ...HITL_CONFIG.toolRisk },
        bypassUpTo: HITL_CONFIG.bypassUpTo,
      },
      bypassUpTo: HITL_CONFIG.bypassUpTo,
      pending: hitlStack.pending,
      clock: { nowMs: () => Date.now() },
      newPendingId: () => `pend-${sessionId}`,
      waitForHitlResolution: hitlStack.waitForHitlResolution,
      hitlNotifier: {
        onQueued(row: { id: string }) {
          for (const n of queuedNotifier) n.onQueued(row);
        },
      },
      cruiseControl: {
        isActive: (sid: string) => sid === sessionId,
        judge: async (input: { toolName: string }) => {
          judgeCalls.push(input.toolName);
          return verdicts.shift() ?? "escalate";
        },
      },
    },
  } as unknown as Parameters<typeof runToolLoop>[0];

  return {
    db,
    options,
    execCount: () => execCount,
    toolMsgs,
    queuedNotifier,
  };
}

describe("runToolLoop cruise control", () => {
  afterEach(() => {
    _resetActiveTurnSurfaces();
  });

  /** Register a fake active turn surface and collect its in-place notices. */
  function captureNotices(sessionId: string): string[] {
    const notices: string[] = [];
    registerActiveTurnSurface(sessionId, (notice) => notices.push(notice));
    return notices;
  }

  it("executes the tool immediately when the judge approves (no HITL queue)", async () => {
    const h = makeHarness("sess-cruise-approve", ["approve"]);
    const notices = captureNotices("sess-cruise-approve");
    await runToolLoop(h.options);
    assert.equal(h.execCount(), 1);
    // The executed tool result is fed back to the model as usual.
    const writeResult = h.toolMsgs.find((m) => m.toolCallId === "w1");
    assert.ok(writeResult);
    assert.match(writeResult!.content, /"ok":\s*true/);
    assert.equal(h.queuedNotifier.length, 0);
    // The decision banner is injected in-place on the active turn surface.
    assert.deepEqual(notices, ["> 🚗✅ Cruise control **approved** `builtin-write`"]);
    h.db.close();
  });

  it("feeds a cruise denial back to the model without queueing HITL", async () => {
    const h = makeHarness("sess-cruise-deny", ["deny"]);
    const notices = captureNotices("sess-cruise-deny");
    await runToolLoop(h.options);
    assert.equal(h.execCount(), 0);
    assert.equal(h.queuedNotifier.length, 0);
    assert.equal(h.toolMsgs.length, 1);
    const body = JSON.parse(h.toolMsgs[0]!.content) as {
      error: string;
      reason: string;
    };
    assert.equal(body.error, "hitl_denied");
    assert.equal(body.reason, "cruise");
    // The decision banner is injected in-place on the active turn surface.
    assert.deepEqual(notices, ["> 🚗❌ Cruise control **denied** `builtin-write`"]);
    h.db.close();
  });

  it("escalations fall through to the normal HITL queue", async () => {
    const h = makeHarness("sess-cruise-escalate", ["escalate"]);
    const notices = captureNotices("sess-cruise-escalate");
    h.queuedNotifier.push({
      onQueued: (row) => {
        queueMicrotask(() => {
          h.options.hitl!.pending.approve(row.id, "test-operator");
        });
      },
    });
    await runToolLoop(h.options);
    assert.equal(h.execCount(), 1);
    const writeResult = h.toolMsgs.find((m) => m.toolCallId === "w1");
    assert.ok(writeResult);
    assert.match(writeResult!.content, /"ok":\s*true/);
    // The elevated banner lands in-turn while the request waits in true HITL.
    assert.deepEqual(notices, ["> 🚗⬆️ Cruise control **elevated** `builtin-write`"]);
    h.db.close();
  });

  it("judge failures escalate to the normal HITL queue", async () => {
    const h = makeHarness("sess-cruise-judge-fail", []);
    const notices = captureNotices("sess-cruise-judge-fail");
    // Replace the judge with one that throws.
    (h.options.hitl as { cruiseControl: { judge: unknown } }).cruiseControl.judge = async () => {
      throw new Error("decision model down");
    };
    h.queuedNotifier.push({
      onQueued: (row) => {
        queueMicrotask(() => {
          h.options.hitl!.pending.approve(row.id, "test-operator");
        });
      },
    });
    await runToolLoop(h.options);
    assert.equal(h.execCount(), 1);
    // A failed judge elevates too, so the elevated banner still lands.
    assert.deepEqual(notices, ["> 🚗⬆️ Cruise control **elevated** `builtin-write`"]);
    h.db.close();
  });

  it("never consults the judge when auto-approve already passed", async () => {
    const h = makeHarness("sess-cruise-auto", ["deny"]);
    const autoApprove = {
      enableSessionTool: () => {},
      enableAgentTool: async () => {},
      shouldAutoApprove: () => true,
    };
    (h.options.hitl as { autoApprove?: unknown }).autoApprove = autoApprove;
    await runToolLoop(h.options);
    assert.equal(h.execCount(), 1);
    h.db.close();
  });
});
