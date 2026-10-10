/**
 * Phase 4 RED tests: `executeSessionAgentTurn` turn-event plumbing.
 *
 * `SessionAgentTurnResult.outcome` must be "completed" on normal completion,
 * "aborted" on TurnAbortedError, and "failed" on any other error. The optional
 * `input.events.onHitlQueued` must fire when a HITL approval row is queued.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DEFAULT_HITL_CONFIG, defaultConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { executeSessionAgentTurn } from "../../src/sessions/session-agent-turn";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop, type RunToolLoopOptions } from "../../src/sessions/tool-loop";
import { TurnAbortedError } from "../../src/sessions/session-turn-abort";

describe("executeSessionAgentTurn — turn outcome + events", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-turn-p4-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({
      id: "sess-p4",
      workspacePath: tmp,
      systemContextToken: "test-token",
    });
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  function baseInput(overrides?: {
    loopImpl?: (opts: RunToolLoopOptions) => Promise<void>;
    createToolCallingClient?: () => {
      completeWithTools(input: unknown): Promise<unknown>;
    };
    events?: Record<string, unknown>;
    /** Called with the shared resolution stack once created (for approve/deny from notifiers). */
    onStack?: (stack: ReturnType<typeof createHitlPendingResolutionStack>) => void;
    hitlNotifier?: { onQueued(row: { id: string }): void };
  }) {
    const config = defaultConfig(tmp);
    const sessions = createSessionStore(db);
    const session = sessions.getById("sess-p4")!;
    const hitlStack = createHitlPendingResolutionStack(db);
    overrides?.onStack?.(hitlStack);
    const builtin = buildBuiltinOnlySessionMcpToolContext();
    return {
      db,
      sessionId: "sess-p4",
      session,
      transcript: createTranscriptStore(db),
      toolRuns: createToolRunStore(db),
      userContent: "phase 4 turn",
      userMetadata: undefined,
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: {
        bypassUpTo: "safe" as const,
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: hitlStack.waitForHitlResolution,
        ...(overrides?.hitlNotifier ? { hitlNotifier: overrides.hitlNotifier } : {}),
      },
      loopImpl: overrides?.loopImpl ?? runToolLoop,
      createToolCallingClient:
        overrides?.createToolCallingClient ??
        (() => ({
          async completeWithTools() {
            return {
              content: "P4_REPLY",
              toolCalls: [],
              usedModel: "stub",
              usedProviderId: "stub",
              degraded: false,
            };
          },
        })),
      resolveMcpContext: async () => builtin,
      ...(overrides?.events ? { events: overrides.events } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("returns outcome 'completed' on normal completion", async () => {
    const result = await executeSessionAgentTurn(baseInput());
    assert.equal(result.outcome, "completed");
  });

  it("returns outcome 'aborted' when the loop throws TurnAbortedError", async () => {
    const result = await executeSessionAgentTurn(
      baseInput({
        loopImpl: async () => {
          throw new TurnAbortedError();
        },
      }),
    );
    assert.equal(result.outcome, "aborted");
  });

  it("returns outcome 'failed' when the loop throws any other error", async () => {
    const result = await executeSessionAgentTurn(
      baseInput({
        loopImpl: async () => {
          throw new Error("boom");
        },
      }),
    );
    assert.equal(result.outcome, "failed");
  });

  it("fires events.onHitlQueued when an approval row is queued", async () => {
    const queued: { name: string; argsJson: string }[] = [];
    let modelTurn = 0;
    let sharedStack: ReturnType<typeof createHitlPendingResolutionStack> | undefined;
    const input = baseInput({
      createToolCallingClient: () => ({
        async completeWithTools() {
          if (modelTurn++ === 0) {
            return {
              content: null,
              toolCalls: [
                {
                  id: "w1",
                  name: "builtin-write",
                  arguments: '{"path":"notes.txt","content":"hi"}',
                },
              ],
              usedModel: "stub",
              usedProviderId: "stub",
              degraded: false,
            };
          }
          return {
            content: "P4_HITL_REPLY",
            toolCalls: [],
            usedModel: "stub",
            usedProviderId: "stub",
            degraded: false,
          };
        },
      }),
      onStack: (s) => {
        sharedStack = s;
      },
      events: {
        onHitlQueued: (call: { name: string; argsJson: string }) => {
          queued.push(call);
        },
      },
      // Approve via the existing notifier seam so the loop proceeds even in RED
      // (events.onHitlQueued is a stub and never fires yet).
      hitlNotifier: {
        onQueued(row) {
          queueMicrotask(() => {
            sharedStack!.pending.approve(row.id, "test-op");
          });
        },
      },
    });

    const result = await executeSessionAgentTurn(input);
    assert.equal(result.latestAssistantText, "P4_HITL_REPLY");
    assert.equal(queued.length, 1, "onHitlQueued should fire for the queued tool");
    assert.equal(queued[0]!.name, "builtin-write");
  });
});
