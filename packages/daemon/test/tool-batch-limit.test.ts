import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { defaultMigrationsDir, migrate } from "../src/db/migrate";
import { runToolLoop } from "../src/sessions/tool-loop";
import { createSessionStore } from "../src/sessions/session-store";
import { createToolRunStore } from "../src/sessions/tool-run-store";
import { createPolicyEngine } from "../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../src/policy/tool-loop-bridge";

function makeBatch(count: number): { id: string; name: string; argsJson: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `call-${i + 1}`,
    name: "builtin-read",
    argsJson: JSON.stringify({ index: i }),
  }));
}

describe("runToolLoop maxToolsPerBatch", () => {
  it("rejects a batch of 11 over the default limit of 10 without executing anything", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-b1", workspacePath: "/w/sess-b1" });
    const engine = createPolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["builtin-read"], deny: [], review: [] },
      },
    });
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "sess-b1",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "run-corr-b1",
    });
    let calls = 0;
    const pushed: { toolCallId: string; content: string }[] = [];
    const model = {
      async complete() {
        if (calls++ === 0) {
          return { content: null, toolCalls: makeBatch(11) };
        }
        return { content: null, toolCalls: [] };
      },
      pushToolMessage(input: { toolCallId: string; content: string }) {
        pushed.push(input);
      },
    };
    let executed = 0;
    await runToolLoop({
      db,
      sessionId: "sess-b1",
      runId: "run-b1",
      principalId: "sess-b1",
      policy,
      audit,
      model,
      tools: [{ name: "builtin-read" }],
      executor: {
        execute: async () => {
          executed++;
          return { resultJson: "{}" };
        },
      },
      toolRuns: createToolRunStore(db),
    });

    // Nothing in the oversized batch executed.
    assert.strictEqual(executed, 0);
    // Every tool_call id received a structured failure response.
    assert.strictEqual(pushed.length, 11);
    const ids = new Set(pushed.map((p) => p.toolCallId));
    assert.strictEqual(ids.size, 11);
    for (const p of pushed) {
      const body = JSON.parse(p.content);
      assert.strictEqual(body.error, "tool_batch_limit_exceeded");
      assert.match(body.message, /maxToolsPerBatch \(10\)/);
      assert.match(body.message, /retry with a smaller batch/);
    }
    db.close();
  });

  it("executes a batch of exactly 10 calls normally", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-b2", workspacePath: "/w/sess-b2" });
    const engine = createPolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["builtin-read"], deny: [], review: [] },
      },
    });
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "sess-b2",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "run-corr-b2",
    });
    let calls = 0;
    const pushed: { toolCallId: string; content: string }[] = [];
    const model = {
      async complete() {
        if (calls++ === 0) {
          return { content: null, toolCalls: makeBatch(10) };
        }
        return { content: null, toolCalls: [] };
      },
      pushToolMessage(input: { toolCallId: string; content: string }) {
        pushed.push(input);
      },
    };
    let executed = 0;
    await runToolLoop({
      db,
      sessionId: "sess-b2",
      runId: "run-b2",
      principalId: "sess-b2",
      policy,
      audit,
      model,
      tools: [{ name: "builtin-read" }],
      executor: {
        execute: async () => {
          executed++;
          return { resultJson: "{}" };
        },
      },
      toolRuns: createToolRunStore(db),
    });

    assert.strictEqual(executed, 10);
    assert.strictEqual(
      pushed.filter((p) => JSON.parse(p.content).error === "tool_batch_limit_exceeded").length,
      0,
    );
    db.close();
  });

  it("honors a configured smaller limit and reports it in the failure response", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-b3", workspacePath: "/w/sess-b3" });
    const engine = createPolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["builtin-read"], deny: [], review: [] },
      },
    });
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "sess-b3",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "run-corr-b3",
    });
    // Mirrors session-agent-turn resolution of agents.maxToolsPerBatch.
    const configured = { agents: { maxToolsPerBatch: 3 } };
    const maxToolsPerBatch = configured.agents.maxToolsPerBatch ?? 10;
    let calls = 0;
    const pushed: { toolCallId: string; content: string }[] = [];
    const model = {
      async complete() {
        if (calls++ === 0) {
          return { content: null, toolCalls: makeBatch(4) };
        }
        return { content: null, toolCalls: [] };
      },
      pushToolMessage(input: { toolCallId: string; content: string }) {
        pushed.push(input);
      },
    };
    let executed = 0;
    await runToolLoop({
      db,
      sessionId: "sess-b3",
      runId: "run-b3",
      principalId: "sess-b3",
      policy,
      audit,
      model,
      tools: [{ name: "builtin-read" }],
      executor: {
        execute: async () => {
          executed++;
          return { resultJson: "{}" };
        },
      },
      toolRuns: createToolRunStore(db),
      maxToolsPerBatch,
    });

    assert.strictEqual(executed, 0);
    assert.strictEqual(pushed.length, 4);
    for (const p of pushed) {
      const body = JSON.parse(p.content);
      assert.strictEqual(body.error, "tool_batch_limit_exceeded");
      assert.match(body.message, /maxToolsPerBatch \(3\)/);
    }
    db.close();
  });
});
