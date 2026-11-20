// ---------------------------------------------------------------------------
// tool-loop integration for configurable system gates.
//
// Exercises the tool loop's system-gate hook: `pre` short-circuits a call
// before execution (and before HITL), while a null `pre` lets the external
// executor run normally.
//
// Fixture pattern from `mcp/tool-loop-mcp.test.ts` (in-memory migrated DB +
// createSessionStore + createToolLoopPolicyAndAudit) and the HITL queueing
// pattern from `tool-loop.test.ts` (auto-deny notifier so a queued row never
// hangs the loop).
// ---------------------------------------------------------------------------
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_HITL_CONFIG, DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createPolicyEngine } from "../../src/policy/engine";
import { createToolLoopPolicyAndAudit } from "../../src/policy/tool-loop-bridge";
import { runToolLoop, type RunToolLoopOptions } from "../../src/sessions/tool-loop";
import { createSessionStore, getSessionContextSegmentId } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import {
  buildAggregatedMcpCatalog,
  createMcpRoutingToolExecutor,
  mcpToolsForToolLoop,
} from "../../src/mcp/tool-loop-mcp";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";

/**
 * Shape of the system-gates hook (see research, Step 2). Local declaration so
 * the test file compiles before `system-gates.ts` exists; the tool loop option
 * itself is the subject under test.
 */
interface TestSystemGates {
  readonly pre: (input: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
  }) => Promise<{ resultJson: string } | null>;
  readonly post: (input: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
    resultJson: string;
  }) => Promise<void>;
}

describe("runToolLoop with systemGates", () => {
  let db: Database.Database;
  let runSeq = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "s1", workspacePath: "/w/s1" });
  });

  afterEach(() => {
    db.close();
  });

  /** Builds a loop that emits one `demo_ext-noop` call then terminates. */
  function buildLoop(opts: { systemGates?: TestSystemGates; riskTier?: string }) {
    const engine = createPolicyEngine(DEFAULT_POLICY_CONFIG);
    const principal: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "s1",
      source: "agent",
    };
    const { policy, audit } = createToolLoopPolicyAndAudit({
      engine,
      principal,
      db,
      correlationId: "run-gates",
    });
    const aggregated = buildAggregatedMcpCatalog([
      {
        sourceId: "demo_ext",
        tools: [{ name: "noop", inputSchema: { type: "object" } }],
      },
    ]);
    const tools = mcpToolsForToolLoop(aggregated);
    const external = vi.fn(async () => ({ resultJson: JSON.stringify({ ok: true }) }));
    const executor = createMcpRoutingToolExecutor({
      aggregated,
      builtin: async () => ({ resultJson: "{}" }),
      external,
    });
    const toolRuns = createToolRunStore(db);
    const transcript = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "s1");
    const hitlStack = createHitlPendingResolutionStack(db);

    let modelStep = 0;
    const runId = `run-gates-${++runSeq}`;
    const base: RunToolLoopOptions = {
      db,
      sessionId: "s1",
      runId,
      principalId: "s1",
      policy,
      audit,
      model: {
        async complete() {
          modelStep += 1;
          if (modelStep === 1) {
            return {
              content: null,
              toolCalls: [{ id: "c1", name: "demo_ext-noop", argsJson: "{}" }],
            };
          }
          return { content: "done", toolCalls: [] };
        },
      },
      tools,
      executor,
      toolRuns,
      transcript,
      contextSegmentId: seg,
      hitl: {
        config: {
          ...DEFAULT_HITL_CONFIG,
          toolRisk: { ...DEFAULT_HITL_CONFIG.toolRisk, "demo_ext-noop": opts.riskTier ?? "safe" },
        },
        bypassUpTo: "safe",
        pending: hitlStack.pending,
        clock: { nowMs: () => 1_700_000_000_000 },
        newPendingId: () => "pend-gates",
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        // If a row is ever queued (i.e. the gate did NOT run first), auto-deny
        // so the loop completes and the assertion below can report the failure.
        hitlNotifier: {
          onQueued(row) {
            queueMicrotask(() => {
              hitlStack.pending.deny(row.id, "test-op");
            });
          },
        },
      },
    };

    // Spread keeps the call typechecking whether or not the option is declared
    // on RunToolLoopOptions.
    return {
      options: opts.systemGates
        ? ({ ...base, systemGates: opts.systemGates } as RunToolLoopOptions)
        : base,
      external,
      transcript,
      seg,
      pending: hitlStack.pending,
      runId,
    };
  }

  it("gated pre result short-circuits: executor never invoked, gated payload in transcript, no HITL row", async () => {
    const { options, external, transcript, seg, pending, runId } = buildLoop({
      // An otherwise-approval-worthy tool: under bypassUpTo "safe" a critical
      // tool would queue for HITL — the gate must preempt that.
      riskTier: "critical",
      systemGates: {
        async pre() {
          return { resultJson: JSON.stringify({ gated: true, message: "read AGENTS.md first" }) };
        },
        async post() {},
      },
    });

    await runToolLoop(options);

    assert.equal(external.mock.calls.length, 0, "external executor must never be invoked");
    assert.equal(pending.listPendingForSession("s1").length, 0, "no HITL row queued");

    const page = transcript.listPage({
      sessionId: "s1",
      contextSegmentId: seg,
      afterSeq: 0,
      limit: 20,
    });
    const toolMsgs = page.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 1, "exactly one tool message (the gated payload)");
    const body = JSON.parse(toolMsgs[0]!.content!) as { gated: boolean; message: string };
    assert.equal(body.gated, true);
    assert.match(body.message, /AGENTS\.md/);

    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = ?`).get(runId) as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "completed", "loop must complete after a gated skip");
  });

  it("pre returning null proceeds to normal execution", async () => {
    const { options, external, runId } = buildLoop({
      systemGates: {
        async pre() {
          return null;
        },
        async post() {},
      },
    });

    await runToolLoop(options);

    assert.equal(external.mock.calls.length, 1, "executor runs when pre returns null");
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = ?`).get(runId) as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "completed");
  });
});
