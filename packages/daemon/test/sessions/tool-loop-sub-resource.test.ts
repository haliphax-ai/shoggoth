import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "node:test";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createHitlAutoApproveGate } from "../../src/hitl/hitl-auto-approve";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";
import { createDefaultSubResourceRegistry } from "../../src/policy/sub-resource";

function setupDb(sessionId: string) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  createSessionStore(db).create({ id: sessionId, workspacePath: `/w/${sessionId}` });
  return db;
}

function setupPolicy(db: Database.Database, sessionId: string) {
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
  return createToolLoopPolicyAndAudit({
    engine,
    principal,
    db,
    correlationId: `corr-${sessionId}`,
  });
}

describe("tool-loop sub-resource extraction", () => {
  it("exec tool call with 'curl ...' is enqueued as exec:curl in HITL", async () => {
    const db = setupDb("s-sub-curl");
    const hitlStack = createHitlPendingResolutionStack(db);
    const { policy, audit } = setupPolicy(db, "s-sub-curl");
    const toolRuns = createToolRunStore(db);

    const queuedToolNames: string[] = [];
    let modelTurn = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc1",
              name: "exec",
              argsJson: JSON.stringify({ command: "curl https://example.com" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      db,
      sessionId: "s-sub-curl",
      runId: "run-sub-curl",
      principalId: "s-sub-curl",
      policy,
      audit,
      model,
      tools: [{ name: "exec" }],
      executor: {
        execute: async () => ({ resultJson: '{"ok":true}' }),
      },
      toolRuns,
      subResourceRegistry: createDefaultSubResourceRegistry(),
      hitl: {
        config: {
          defaultApprovalTimeoutMs: 300_000,
          toolRisk: { exec: "critical" },
          roleBypassUpTo: {},
        },
        principalRoles: [],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-sub-curl",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queuedToolNames.push(row.toolName);
            hitlStack.pending.approve(row.id, "test-operator");
          },
        },
      },
    });

    assert.deepStrictEqual(queuedToolNames, ["exec:curl"]);
    db.close();
  });

  it("sticky approval for exec:curl auto-approves future curl calls", async () => {
    const db = setupDb("s-sticky-curl");
    const hitlStack = createHitlPendingResolutionStack(db);
    const { policy, audit } = setupPolicy(db, "s-sticky-curl");
    const toolRuns = createToolRunStore(db);
    const autoApprove = createHitlAutoApproveGate();
    // Simulate prior sticky approval for exec:curl
    autoApprove.enableSessionTool("s-sticky-curl", "exec:curl");

    const queuedToolNames: string[] = [];
    const executed: string[] = [];
    let modelTurn = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc1",
              name: "exec",
              argsJson: JSON.stringify({ command: "curl https://example.com" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      db,
      sessionId: "s-sticky-curl",
      runId: "run-sticky-curl",
      principalId: "s-sticky-curl",
      policy,
      audit,
      model,
      tools: [{ name: "exec" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: '{"ok":true}' };
        },
      },
      toolRuns,
      subResourceRegistry: createDefaultSubResourceRegistry(),
      hitl: {
        config: {
          defaultApprovalTimeoutMs: 300_000,
          toolRisk: { exec: "critical" },
          roleBypassUpTo: {},
        },
        principalRoles: [],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-sticky",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        autoApprove,
        hitlNotifier: {
          onQueued(row) {
            queuedToolNames.push(row.toolName);
            hitlStack.pending.approve(row.id, "test-operator");
          },
        },
      },
    });

    // Should NOT have been queued — auto-approved via sticky
    assert.deepStrictEqual(queuedToolNames, []);
    assert.deepStrictEqual(executed, ["exec"]);
    db.close();
  });

  it("sticky approval for exec:curl does NOT auto-approve exec:rm", async () => {
    const db = setupDb("s-sticky-rm");
    const hitlStack = createHitlPendingResolutionStack(db);
    const { policy, audit } = setupPolicy(db, "s-sticky-rm");
    const toolRuns = createToolRunStore(db);
    const autoApprove = createHitlAutoApproveGate();
    // Only curl is approved, not rm
    autoApprove.enableSessionTool("s-sticky-rm", "exec:curl");

    const queuedToolNames: string[] = [];
    let modelTurn = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc1",
              name: "exec",
              argsJson: JSON.stringify({ command: "rm -rf /tmp/foo" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      db,
      sessionId: "s-sticky-rm",
      runId: "run-sticky-rm",
      principalId: "s-sticky-rm",
      policy,
      audit,
      model,
      tools: [{ name: "exec" }],
      executor: {
        execute: async () => ({ resultJson: '{"ok":true}' }),
      },
      toolRuns,
      subResourceRegistry: createDefaultSubResourceRegistry(),
      hitl: {
        config: {
          defaultApprovalTimeoutMs: 300_000,
          toolRisk: { exec: "critical" },
          roleBypassUpTo: {},
        },
        principalRoles: [],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-rm",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        autoApprove,
        hitlNotifier: {
          onQueued(row) {
            queuedToolNames.push(row.toolName);
            hitlStack.pending.approve(row.id, "test-operator");
          },
        },
      },
    });

    // rm should have been queued for HITL (not auto-approved)
    assert.deepStrictEqual(queuedToolNames, ["exec:rm"]);
    db.close();
  });

  it("tool without a registered extractor works exactly as before", async () => {
    const db = setupDb("s-no-extractor");
    const hitlStack = createHitlPendingResolutionStack(db);
    const { policy, audit } = setupPolicy(db, "s-no-extractor");
    const toolRuns = createToolRunStore(db);

    const queuedToolNames: string[] = [];
    let modelTurn = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc1",
              name: "write",
              argsJson: JSON.stringify({ path: "/tmp/foo", content: "bar" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      db,
      sessionId: "s-no-extractor",
      runId: "run-no-extractor",
      principalId: "s-no-extractor",
      policy,
      audit,
      model,
      tools: [{ name: "write" }],
      executor: {
        execute: async () => ({ resultJson: '{"ok":true}' }),
      },
      toolRuns,
      subResourceRegistry: createDefaultSubResourceRegistry(),
      hitl: {
        config: {
          defaultApprovalTimeoutMs: 300_000,
          toolRisk: { write: "caution" },
          roleBypassUpTo: {},
        },
        principalRoles: [],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-write",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queuedToolNames.push(row.toolName);
            hitlStack.pending.approve(row.id, "test-operator");
          },
        },
      },
    });

    // Should be queued as bare "write" — no sub-resource extraction
    assert.deepStrictEqual(queuedToolNames, ["write"]);
    db.close();
  });

  it("HITL bypass with bare 'exec' in allow list skips all exec sub-commands", async () => {
    const db = setupDb("s-bypass-bare");
    const hitlStack = createHitlPendingResolutionStack(db);
    // Policy allows exec (bare) — should allow exec:curl compound resource
    const engine = createPolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["exec"], deny: [] },
      },
    });
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "s-bypass-bare",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "corr-bypass-bare",
    });
    const toolRuns = createToolRunStore(db);

    const executed: string[] = [];
    let modelTurn = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc1",
              name: "exec",
              argsJson: JSON.stringify({ command: "curl https://example.com" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      db,
      sessionId: "s-bypass-bare",
      runId: "run-bypass-bare",
      principalId: "s-bypass-bare",
      policy,
      audit,
      model,
      tools: [{ name: "exec" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: '{"ok":true}' };
        },
      },
      toolRuns,
      subResourceRegistry: createDefaultSubResourceRegistry(),
    });

    // Policy allows "exec" which covers "exec:curl" — should execute without HITL
    assert.deepStrictEqual(executed, ["exec"]);
    db.close();
  });

  it("HITL bypass with 'exec:curl' only skips curl calls, not rm", async () => {
    const db = setupDb("s-bypass-specific");
    const hitlStack = createHitlPendingResolutionStack(db);
    // Policy allows exec:curl but not exec:rm
    const engine = createPolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["exec:curl", "write"], deny: [] },
      },
    });
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "s-bypass-specific",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "corr-bypass-specific",
    });
    const toolRuns = createToolRunStore(db);

    // First call: exec curl — should pass policy
    const executed: string[] = [];
    let modelTurn = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc1",
              name: "exec",
              argsJson: JSON.stringify({ command: "curl https://example.com" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      db,
      sessionId: "s-bypass-specific",
      runId: "run-bypass-curl",
      principalId: "s-bypass-specific",
      policy,
      audit,
      model,
      tools: [{ name: "exec" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: '{"ok":true}' };
        },
      },
      toolRuns,
      subResourceRegistry: createDefaultSubResourceRegistry(),
    });

    assert.deepStrictEqual(executed, ["exec"]);

    // Second call: exec rm — should be denied by policy (exec:rm not in allow list)
    let modelTurn2 = 0;
    const model2 = {
      async complete() {
        if (modelTurn2++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc2",
              name: "exec",
              argsJson: JSON.stringify({ command: "rm -rf /tmp/foo" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await assert.rejects(
      runToolLoop({
        db,
        sessionId: "s-bypass-specific",
        runId: "run-bypass-rm",
        principalId: "s-bypass-specific",
        policy,
        audit,
        model: model2,
        tools: [{ name: "exec" }],
        executor: {
          execute: async ({ name }) => {
            executed.push(name);
            return { resultJson: '{"ok":true}' };
          },
        },
        toolRuns,
        subResourceRegistry: createDefaultSubResourceRegistry(),
      }),
      /default_deny/,
    );

    // rm should NOT have executed
    assert.deepStrictEqual(executed, ["exec"]);
    db.close();
  });

  it("compound resource appears in audit records", async () => {
    const db = setupDb("s-audit-compound");
    const hitlStack = createHitlPendingResolutionStack(db);
    const { policy, audit } = setupPolicy(db, "s-audit-compound");
    const toolRuns = createToolRunStore(db);

    let modelTurn = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc1",
              name: "exec",
              argsJson: JSON.stringify({ command: "git status" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      db,
      sessionId: "s-audit-compound",
      runId: "run-audit-compound",
      principalId: "s-audit-compound",
      policy,
      audit,
      model,
      tools: [{ name: "exec" }],
      executor: {
        execute: async () => ({ resultJson: '{"ok":true}' }),
      },
      toolRuns,
      subResourceRegistry: createDefaultSubResourceRegistry(),
      hitl: {
        config: {
          defaultApprovalTimeoutMs: 300_000,
          toolRisk: { exec: "critical" },
          roleBypassUpTo: {},
        },
        principalRoles: [],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-audit",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            hitlStack.pending.approve(row.id, "test-operator");
          },
        },
      },
    });

    // Check that audit records use the compound resource
    const auditRows = db
      .prepare(`SELECT action, resource FROM audit_log WHERE resource LIKE 'exec:%' ORDER BY rowid`)
      .all() as { action: string; resource: string }[];

    // Should have policy check, hitl queued, execute_start, execute_done all with exec:git
    const resources = auditRows.map((r) => r.resource);
    assert.ok(resources.every((r) => r === "exec:git"), `Expected all resources to be exec:git, got: ${JSON.stringify(resources)}`);
    assert.ok(resources.length >= 2, `Expected at least 2 audit rows with exec:git, got ${resources.length}`);
    db.close();
  });

  it("without subResourceRegistry option, tool loop works as before (backward compat)", async () => {
    const db = setupDb("s-no-registry");
    const hitlStack = createHitlPendingResolutionStack(db);
    const { policy, audit } = setupPolicy(db, "s-no-registry");
    const toolRuns = createToolRunStore(db);

    const queuedToolNames: string[] = [];
    let modelTurn = 0;
    const model = {
      async complete() {
        if (modelTurn++ === 0) {
          return {
            content: null,
            toolCalls: [{
              id: "tc1",
              name: "exec",
              argsJson: JSON.stringify({ command: "curl https://example.com" }),
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      db,
      sessionId: "s-no-registry",
      runId: "run-no-registry",
      principalId: "s-no-registry",
      policy,
      audit,
      model,
      tools: [{ name: "exec" }],
      executor: {
        execute: async () => ({ resultJson: '{"ok":true}' }),
      },
      toolRuns,
      // No subResourceRegistry — should use bare tool name
      hitl: {
        config: {
          defaultApprovalTimeoutMs: 300_000,
          toolRisk: { exec: "critical" },
          roleBypassUpTo: {},
        },
        principalRoles: [],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => "pend-no-reg",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        hitlNotifier: {
          onQueued(row) {
            queuedToolNames.push(row.toolName);
            hitlStack.pending.approve(row.id, "test-operator");
          },
        },
      },
    });

    // Without registry, should use bare "exec"
    assert.deepStrictEqual(queuedToolNames, ["exec"]);
    db.close();
  });
});
