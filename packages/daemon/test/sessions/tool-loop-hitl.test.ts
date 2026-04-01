import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "node:test";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";

describe("runToolLoop HITL (shared pending store + resolution hub)", () => {
  it("resumes and executes the tool after pending.approve (same as control-socket approve)", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-hitl", workspacePath: "/w/sess-hitl" });
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
      sessionId: "sess-hitl",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "run-hitl-approve",
    });
    const toolRuns = createToolRunStore(db);
    let modelTurn = 0;
    const toolMsgs: { toolCallId: string; content: string }[] = [];
    let execCount = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{ id: "w1", name: "builtin.write", argsJson: "{}" }],
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
      sessionId: "sess-hitl",
      runId: "run-1",
      principalId: "sess-hitl",
      policy,
      audit,
      model,
      tools: [{ name: "builtin.write" }],
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
          toolRisk: { read: "safe", write: "caution", exec: "critical" },
          agentBypassUpTo: {},
        },
        principalRoles: [],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-approve-1",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queueMicrotask(() => {
              hitlStack.pending.approve(row.id, "test-operator");
            });
          },
        },
      },
    });

    assert.equal(execCount, 1);
    const writeResult = toolMsgs.find((m) => m.toolCallId === "w1");
    assert.ok(writeResult);
    assert.match(writeResult!.content, /"ok":\s*true/);
    db.close();
  });

  it("does not execute after pending.deny; feeds tool error and completes the loop", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-hitl-d", workspacePath: "/w/sess-hitl-d" });
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
      sessionId: "sess-hitl-d",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "run-hitl-deny",
    });
    const toolRuns = createToolRunStore(db);
    let modelTurn = 0;
    const toolMsgs: { toolCallId: string; content: string }[] = [];
    let execCount = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{ id: "w1", name: "builtin.write", argsJson: "{}" }],
          };
        }
        return { content: "after deny", toolCalls: [] };
      },
      pushToolMessage(input: { toolCallId: string; content: string }) {
        toolMsgs.push(input);
      },
    };

    await runToolLoop({
      db,
      sessionId: "sess-hitl-d",
      runId: "run-2",
      principalId: "sess-hitl-d",
      policy,
      audit,
      model,
      tools: [{ name: "builtin.write" }],
      executor: {
        execute: async () => {
          execCount++;
          return { resultJson: "{}" };
        },
      },
      toolRuns,
      hitl: {
        config: {
          defaultApprovalTimeoutMs: 300_000,
          toolRisk: { read: "safe", write: "caution", exec: "critical" },
          agentBypassUpTo: {},
        },
        principalRoles: [],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-deny-1",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queueMicrotask(() => {
              hitlStack.pending.deny(row.id, "test-operator");
            });
          },
        },
      },
    });

    assert.equal(execCount, 0);
    const denied = toolMsgs.find((m) => m.toolCallId === "w1");
    assert.ok(denied);
    assert.match(denied!.content, /hitl_denied/);
    const deniedAudits = db
      .prepare(`SELECT action, outcome FROM audit_log WHERE action = 'hitl.denied'`)
      .all() as { action: string; outcome: string }[];
    assert.equal(deniedAudits.length, 1);
    db.close();
  });
});
