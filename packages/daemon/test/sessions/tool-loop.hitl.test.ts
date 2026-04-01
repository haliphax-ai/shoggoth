import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_HITL_CONFIG, DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, it } from "node:test";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";

describe("runToolLoop HITL", () => {
  it("executes the tool after operator approval (shared store + resolution hub)", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "s-hitl-ok", workspacePath: "/w/s-hitl-ok" });

    const stack = createHitlPendingResolutionStack(db);
    const engine = createPolicyEngine(DEFAULT_POLICY_CONFIG);
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "s-hitl-ok",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "corr-hitl-ok",
    });

    let completions = 0;
    const model = {
      async complete() {
        completions += 1;
        if (completions === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "tc-exec",
                name: "builtin.exec",
                argsJson: JSON.stringify({ argv: ["true"] }),
              },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };

    const executed: string[] = [];
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "s-hitl-ok",
      runId: "run-hitl-ok",
      principalId: "s-hitl-ok",
      policy,
      audit,
      model,
      tools: [{ name: "builtin.exec" }],
      executor: {
        execute: async ({ name }) => {
          executed.push(name);
          return { resultJson: JSON.stringify({ ok: true }) };
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
            const ok = stack.pending.approve(row.id, "test-operator");
            assert.equal(ok, true);
          },
        },
      },
    });

    assert.deepStrictEqual(executed, ["builtin.exec"]);
    const tr = db
      .prepare(`SELECT status FROM tool_runs WHERE id = ?`)
      .get("run-hitl-ok") as { status: string } | undefined;
    assert.equal(tr?.status, "completed");
    db.close();
  });

  it("does not execute the tool when denied; feeds denial to model if pushToolMessage exists", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "s-hitl-deny", workspacePath: "/w/s-hitl-deny" });

    const stack = createHitlPendingResolutionStack(db);
    const engine = createPolicyEngine(DEFAULT_POLICY_CONFIG);
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "s-hitl-deny",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "corr-hitl-deny",
    });

    const pushed: { toolCallId: string; content: string }[] = [];
    let completions = 0;
    const model = {
      async complete() {
        completions += 1;
        if (completions === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "tc-exec-2",
                name: "builtin.exec",
                argsJson: "{}",
              },
            ],
          };
        }
        return { content: "after-deny", toolCalls: [] };
      },
      pushToolMessage(input: { toolCallId: string; content: string }) {
        pushed.push(input);
      },
    };

    const executed: string[] = [];
    const toolRuns = createToolRunStore(db);

    await runToolLoop({
      db,
      sessionId: "s-hitl-deny",
      runId: "run-hitl-deny",
      principalId: "s-hitl-deny",
      policy,
      audit,
      model,
      tools: [{ name: "builtin.exec" }],
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
            stack.pending.deny(row.id, "test-operator");
          },
        },
      },
    });

    assert.deepStrictEqual(executed, []);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]!.toolCallId, "tc-exec-2");
    assert.match(pushed[0]!.content, /hitl_denied/);

    const tr = db
      .prepare(`SELECT status FROM tool_runs WHERE id = ?`)
      .get("run-hitl-deny") as { status: string } | undefined;
    assert.equal(tr?.status, "completed");
    db.close();
  });
});
