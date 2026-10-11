import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_HITL_CONFIG, DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop, type ModelClient } from "../../src/sessions/tool-loop";

/** In-memory migrated DB + session + policy bridge over allow/deny/review lists. */
function setup(sessionId: string, tools: { allow: string[]; deny: string[]; review: string[] }) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  createSessionStore(db).create({ id: sessionId, workspacePath: `/w/${sessionId}` });

  const engine = createPolicyEngine({
    ...DEFAULT_POLICY_CONFIG,
    agent: {
      ...DEFAULT_POLICY_CONFIG.agent,
      tools,
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
    correlationId: `corr-${sessionId}`,
  });
  const stack = createHitlPendingResolutionStack(db);
  const toolRuns = createToolRunStore(db);
  return { db, policy, audit, stack, toolRuns };
}

function pendingCount(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM hitl_pending_actions WHERE session_id = ?`)
    .get(sessionId) as { n: number };
  return row.n;
}

describe("runToolLoop policy tiers and unresolvable tool calls", () => {
  it("returns a tool error for an unknown tool and the turn completes", async () => {
    const { db, policy, audit, toolRuns } = setup("s-unknown", {
      allow: ["*"],
      deny: [],
      review: [],
    });

    const pushed: { toolCallId: string; content: string }[] = [];
    let hops = 0;
    const model: ModelClient = {
      async complete() {
        hops += 1;
        if (hops === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "not-a-real-tool", argsJson: "{}" }],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const executed: string[] = [];

    await runToolLoop({
      db,
      sessionId: "s-unknown",
      runId: "run-unknown",
      principalId: "s-unknown",
      policy,
      audit,
      model,
      tools: [{ name: "builtin-read" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
    });

    assert.deepStrictEqual(executed, []);
    assert.equal(pushed.length, 1);
    assert.ok(pushed[0]!.content.includes("unknown_tool"));
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-unknown'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
    db.close();
  });

  it("survives a tool call without argsJson: invalid_arguments error, turn completes", async () => {
    const { db, policy, audit, toolRuns } = setup("s-no-args", {
      allow: ["*"],
      deny: [],
      review: [],
    });

    const pushed: { toolCallId: string; content: string }[] = [];
    let hops = 0;
    const model: ModelClient = {
      async complete() {
        hops += 1;
        if (hops === 1) {
          // Malformed provider output: the tool call arrives without arguments.
          return {
            content: null,
            toolCalls: [
              { id: "c1", name: "builtin-read", argsJson: undefined as unknown as string },
            ],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const executed: string[] = [];

    // Must NOT throw (previously crashed the turn with a TypeError inside
    // args sanitization before any per-call error handling ran).
    await runToolLoop({
      db,
      sessionId: "s-no-args",
      runId: "run-no-args",
      principalId: "s-no-args",
      policy,
      audit,
      model,
      tools: [{ name: "builtin-read" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
    });

    assert.deepStrictEqual(executed, []);
    assert.equal(pushed.length, 1);
    assert.ok(pushed[0]!.content.includes("invalid_arguments"));
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-no-args'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
    db.close();
  });

  it("survives a tool call with a missing name: invalid_tool_name error, turn completes", async () => {
    const { db, policy, audit, toolRuns } = setup("s-no-name", {
      allow: ["*"],
      deny: [],
      review: [],
    });

    const pushed: { toolCallId: string; content: string }[] = [];
    let hops = 0;
    const model: ModelClient = {
      async complete() {
        hops += 1;
        if (hops === 1) {
          // Malformed provider output: no resolvable tool descriptor/name.
          return {
            content: null,
            toolCalls: [{ id: "c1", name: undefined as unknown as string, argsJson: "{}" }],
          };
        }
        return { content: "recovered", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const executed: string[] = [];

    await runToolLoop({
      db,
      sessionId: "s-no-name",
      runId: "run-no-name",
      principalId: "s-no-name",
      policy,
      audit,
      model,
      tools: [{ name: "builtin-read" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
    });

    assert.deepStrictEqual(executed, []);
    assert.equal(pushed.length, 1);
    assert.ok(pushed[0]!.content.includes("invalid_tool_name"));
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-no-name'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
    db.close();
  });

  it("deny-listed tool is hard-blocked immediately: no HITL entry, no delay, no approval request", async () => {
    const sessionId = "s-policy-deny";
    const { db, policy, audit, stack, toolRuns } = setup(sessionId, {
      allow: ["*"],
      deny: ["builtin-exec"],
      review: [],
    });

    const pushed: { toolCallId: string; content: string }[] = [];
    let hops = 0;
    const model: ModelClient = {
      async complete() {
        hops += 1;
        if (hops === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-exec", argsJson: "{}" }],
          };
        }
        return { content: "after-deny", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const executed: string[] = [];
    const notified: string[] = [];
    let waitedForResolution = 0;

    const t0 = Date.now();
    await runToolLoop({
      db,
      sessionId,
      runId: "run-policy-deny",
      principalId: sessionId,
      policy,
      audit,
      model,
      tools: [{ name: "builtin-exec" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "safe",
        pending: stack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: async (pendingId) => {
          waitedForResolution += 1;
          return stack.waitForHitlResolution(pendingId);
        },
        hitlNotifier: {
          onQueued(row) {
            notified.push(row.toolName);
          },
        },
      },
    });
    const elapsed = Date.now() - t0;

    // Immediate hard block: error result into the loop, turn completes.
    assert.deepStrictEqual(executed, []);
    assert.equal(pushed.length, 1);
    assert.ok(pushed[0]!.content.includes("policy_denied"));
    assert.ok(pushed[0]!.content.includes("deny-listed"));
    // Approval machinery untouched: no queue entry, no notifier, no wait.
    assert.equal(pendingCount(db, sessionId), 0);
    assert.deepStrictEqual(notified, []);
    assert.equal(waitedForResolution, 0);
    // No HITL latency (a queued call would block until approval/timeout).
    assert.ok(elapsed < 2000, `expected fast rejection, took ${elapsed}ms`);

    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-policy-deny'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
    db.close();
  });

  it("review-listed tool still queues HITL for human sign-off", async () => {
    const sessionId = "s-policy-review";
    const { db, policy, audit, stack, toolRuns } = setup(sessionId, {
      allow: ["*"],
      deny: [],
      review: ["builtin-write"],
    });

    const pushed: { toolCallId: string; content: string }[] = [];
    let hops = 0;
    const model: ModelClient = {
      async complete() {
        hops += 1;
        if (hops === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-write", argsJson: "{}" }],
          };
        }
        return { content: "after-review", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const executed: string[] = [];
    const queued: { id: string; toolName: string }[] = [];

    await runToolLoop({
      db,
      sessionId,
      runId: "run-policy-review",
      principalId: sessionId,
      policy,
      audit,
      model,
      tools: [{ name: "builtin-write" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "safe",
        pending: stack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: stack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queued.push({ id: row.id, toolName: row.toolName });
            const ok = stack.pending.approve(row.id, "test-operator");
            assert.equal(ok, true);
          },
        },
      },
    });

    // The review tier queued exactly one HITL row, then executed on approval.
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.toolName, "builtin-write");
    assert.deepStrictEqual(executed, ["builtin-write"]);
    // The executed tool result (not an error) was fed back to the model.
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]!.content, "{}");
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-policy-review'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
    db.close();
  });

  it("risk-tier HITL is unchanged: allow-listed critical tool queues, bypass covers it", async () => {
    const sessionId = "s-risk-tier";
    const { db, policy, audit, stack, toolRuns } = setup(sessionId, {
      allow: ["*"],
      deny: [],
      review: [],
    });

    const executed: string[] = [];
    const queued: string[] = [];
    let hops = 0;
    const model: ModelClient = {
      async complete() {
        hops += 1;
        if (hops === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-exec", argsJson: "{}" }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };

    await runToolLoop({
      db,
      sessionId,
      runId: "run-risk-tier",
      principalId: sessionId,
      policy,
      audit,
      model,
      tools: [{ name: "builtin-exec" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "safe",
        pending: stack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: stack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queued.push(row.toolName);
            stack.pending.approve(row.id, "test-operator");
          },
        },
      },
    });

    // builtin-exec is above the safe bypass tier → still queues, then runs.
    assert.deepStrictEqual(queued, ["builtin-exec"]);
    assert.deepStrictEqual(executed, ["builtin-exec"]);

    // With a bypass tier that covers the risk, no queue entry is created.
    const executed2: string[] = [];
    const queued2: string[] = [];
    let hops2 = 0;
    await runToolLoop({
      db,
      sessionId,
      runId: "run-risk-bypass",
      principalId: sessionId,
      policy,
      audit,
      model: {
        async complete() {
          hops2 += 1;
          if (hops2 === 1) {
            return {
              content: null,
              toolCalls: [{ id: "c2", name: "builtin-exec", argsJson: "{}" }],
            };
          }
          return { content: "done", toolCalls: [] };
        },
      },
      tools: [{ name: "builtin-exec" }],
      executor: {
        execute: async ({ name }) => {
          executed2.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "critical",
        pending: stack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: stack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queued2.push(row.toolName);
          },
        },
      },
    });

    assert.deepStrictEqual(queued2, []);
    assert.deepStrictEqual(executed2, ["builtin-exec"]);
    db.close();
  });

  it("deny-glob entry hard-blocks immediately: no HITL entry, no delay, no approval request", async () => {
    const sessionId = "s-policy-deny-glob";
    const { db, policy, audit, stack, toolRuns } = setup(sessionId, {
      allow: ["*"],
      deny: ["builtin-wri*"],
      review: [],
    });

    const pushed: { toolCallId: string; content: string }[] = [];
    let hops = 0;
    const model: ModelClient = {
      async complete() {
        hops += 1;
        if (hops === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-write", argsJson: "{}" }],
          };
        }
        return { content: "after-deny-glob", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const executed: string[] = [];
    const notified: string[] = [];
    let waitedForResolution = 0;

    const t0 = Date.now();
    await runToolLoop({
      db,
      sessionId,
      runId: "run-policy-deny-glob",
      principalId: sessionId,
      policy,
      audit,
      model,
      tools: [{ name: "builtin-write" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "safe",
        pending: stack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: async (pendingId) => {
          waitedForResolution += 1;
          return stack.waitForHitlResolution(pendingId);
        },
        hitlNotifier: {
          onQueued(row) {
            notified.push(row.toolName);
          },
        },
      },
    });
    const elapsed = Date.now() - t0;

    // Immediate hard block: error result into the loop, turn completes.
    assert.deepStrictEqual(executed, []);
    assert.equal(pushed.length, 1);
    assert.ok(pushed[0]!.content.includes("policy_denied"));
    assert.ok(pushed[0]!.content.includes("deny-listed"));
    // Approval machinery untouched: no queue entry, no notifier, no wait.
    assert.equal(pendingCount(db, sessionId), 0);
    assert.deepStrictEqual(notified, []);
    assert.equal(waitedForResolution, 0);
    // No HITL latency (a queued call would block until approval/timeout).
    assert.ok(elapsed < 2000, `expected fast rejection, took ${elapsed}ms`);

    const row = db
      .prepare(`SELECT status FROM tool_runs WHERE id = 'run-policy-deny-glob'`)
      .get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
    db.close();
  });

  it("review-glob entry queues HITL for human sign-off", async () => {
    const sessionId = "s-policy-review-glob";
    const { db, policy, audit, stack, toolRuns } = setup(sessionId, {
      allow: ["*"],
      deny: [],
      review: ["builtin-wri*"],
    });

    const pushed: { toolCallId: string; content: string }[] = [];
    let hops = 0;
    const model: ModelClient = {
      async complete() {
        hops += 1;
        if (hops === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-write", argsJson: "{}" }],
          };
        }
        return { content: "after-review-glob", toolCalls: [] };
      },
      pushToolMessage(msg) {
        pushed.push(msg);
      },
    };
    const executed: string[] = [];
    const queued: { id: string; toolName: string }[] = [];

    await runToolLoop({
      db,
      sessionId,
      runId: "run-policy-review-glob",
      principalId: sessionId,
      policy,
      audit,
      model,
      tools: [{ name: "builtin-write" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: "{}" };
        },
      },
      toolRuns,
      hitl: {
        config: DEFAULT_HITL_CONFIG,
        bypassUpTo: "safe",
        pending: stack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: stack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queued.push({ id: row.id, toolName: row.toolName });
            const ok = stack.pending.approve(row.id, "test-operator");
            assert.equal(ok, true);
          },
        },
      },
    });

    // The review glob queued exactly one HITL row, then executed on approval.
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.toolName, "builtin-write");
    assert.deepStrictEqual(executed, ["builtin-write"]);
    // The executed tool result (not an error) was fed back to the model.
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]!.content, "{}");
    const row = db
      .prepare(`SELECT status FROM tool_runs WHERE id = 'run-policy-review-glob'`)
      .get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
    db.close();
  });
});
