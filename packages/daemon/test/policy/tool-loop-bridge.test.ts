import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { runToolLoop } from "../../src/sessions/tool-loop";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";

describe("createToolLoopPolicyAndAudit", () => {
  it("denies disallowed tools and redacts args in audit", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-a", workspacePath: "/w/sess-a" });
    const engine = createPolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["builtin-read"], deny: [] },
      },
    });
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "sess-a",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "run-corr",
    });
    let calls = 0;
    const model = {
      async complete() {
        if (calls++ === 0) {
          return {
            content: null,
            toolCalls: [{ id: "t1", name: "builtin-exec", argsJson: '{"token":"secret"}' }],
          };
        }
        return { content: null, toolCalls: [] };
      },
    };
    const toolRuns = createToolRunStore(db);
    await assert.rejects(
      runToolLoop({
        db,
        sessionId: "sess-a",
        runId: "run-1",
        principalId: "sess-a",
        policy,
        audit,
        model,
        tools: [{ name: "builtin-read" }, { name: "builtin-exec" }],
        executor: {
          execute: async () => ({ resultJson: "{}" }),
        },
        toolRuns,
      }),
    );
    const rows = db
      .prepare(`SELECT action, resource, outcome, args_redacted_json FROM audit_log ORDER BY id`)
      .all() as {
      action: string;
      resource: string;
      outcome: string;
      args_redacted_json: string | null;
    }[];
    const denied = rows.find((r) => r.action === "authz.tool" && r.outcome === "denied");
    assert.ok(denied);
    assert.strictEqual(denied!.resource, "builtin-exec");
    assert.match(denied!.args_redacted_json ?? "", /REDACTED/);
    db.close();
  });
});
