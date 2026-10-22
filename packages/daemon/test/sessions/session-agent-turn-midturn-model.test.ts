/**
 * Mid-turn model switch: when the session's modelSelection changes while a
 * turn is live, the NEXT tool-loop round must use the newly-set model —
 * re-resolved failover chain / tool client, invocation params, and context
 * window (compaction config) all swap between rounds.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DEFAULT_HITL_CONFIG, defaultConfig } from "@shoggoth/shared";
import { closeTestDb } from "../helpers/close-test-db";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { executeSessionAgentTurn } from "../../src/sessions/session-agent-turn";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";
import { setModelMetadataFromProvider } from "../../src/model-metadata";
import type { ShoggothConfig } from "@shoggoth/shared";

const SESSION_ID = "sess-midturn-model";

describe("executeSessionAgentTurn — mid-turn model switch", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  function makeHitl() {
    const hitlStack = createHitlPendingResolutionStack(db);
    return {
      bypassUpTo: "safe" as const,
      pending: hitlStack.pending,
      clock: { nowMs: () => Date.now() },
      newPendingId: () => randomUUID(),
      waitForHitlResolution: hitlStack.waitForHitlResolution,
    };
  }

  function makeConfig(): ShoggothConfig {
    const config = defaultConfig(tmp);
    config.models = {
      providers: {
        provA: {
          kind: "openai-compatible" as const,
          baseUrl: "http://localhost:1/v1",
          apiKey: "k",
          models: { modelA: { contextWindowTokens: 200_000 } },
        },
        provB: {
          kind: "openai-compatible" as const,
          baseUrl: "http://localhost:2/v1",
          apiKey: "k",
          models: { modelB: { contextWindowTokens: 90_000 } },
        },
      },
      failoverChain: ["provA/modelA"],
    };
    return config;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-midturn-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: SESSION_ID, workspacePath: tmp });
    // Seed the metadata store so ctxWindowTokens resolves for both models.
    setModelMetadataFromProvider("provA", "modelA", 200_000);
    setModelMetadataFromProvider("provB", "modelB", 90_000);
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  function buildInput(
    overrides: {
      createToolCallingClient?: Parameters<
        typeof executeSessionAgentTurn
      >[0]["createToolCallingClient"];
      events?: Parameters<typeof executeSessionAgentTurn>[0]["events"];
      modelInvocationOverride?: Parameters<
        typeof executeSessionAgentTurn
      >[0]["modelInvocationOverride"];
    } = {},
  ) {
    const sessions = createSessionStore(db);
    const session = sessions.getById(SESSION_ID)!;
    return {
      db,
      sessionId: SESSION_ID,
      session,
      transcript: createTranscriptStore(db),
      toolRuns: createToolRunStore(db),
      userContent: "mid-turn model switch",
      userMetadata: undefined,
      env: process.env,
      config: makeConfig(),
      policyEngine: createPolicyEngine(makeConfig().policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG }),
      hitl: makeHitl(),
      loopImpl: runToolLoop,
      createToolCallingClient: overrides.createToolCallingClient,
      resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
      ...(overrides.events ? { events: overrides.events } : {}),
      ...(overrides.modelInvocationOverride
        ? { modelInvocationOverride: overrides.modelInvocationOverride }
        : {}),
    };
  }

  it("applies a mid-turn switch to the next tool-loop round (client swap)", async () => {
    const sessions = createSessionStore(db);
    sessions.update(SESSION_ID, { modelSelection: { model: "provA/modelA" } });

    const chains: (string | undefined)[] = [];
    const createToolCallingClient = ((models) => {
      const primary = models.failoverChain?.[0];
      chains.push(typeof primary === "string" ? primary : undefined);
      const isInitial = chains.length === 1;
      return {
        async completeWithTools() {
          if (isInitial) {
            // First round on provA: flip the session's model mid-turn, the way
            // the session_model op does, then ask for a tool round.
            sessions.update(SESSION_ID, { modelSelection: { model: "provB/modelB" } });
            return {
              content: "PRE_SWITCH",
              toolCalls: [{ id: "t1", name: "no-such-tool", arguments: "{}" }],
              usedModel: "modelA",
              usedProviderId: "provA",
              degraded: false,
            };
          }
          return {
            content: "POST_SWITCH",
            toolCalls: [],
            usedModel: "modelB",
            usedProviderId: "provB",
            degraded: false,
          };
        },
      };
    }) as Parameters<typeof executeSessionAgentTurn>[0]["createToolCallingClient"];

    const result = await executeSessionAgentTurn(buildInput({ createToolCallingClient }));

    assert.equal(result.outcome, "completed");
    assert.equal(result.latestAssistantText, "POST_SWITCH");
    assert.equal(chains.length, 2, "a fresh tool client is resolved per switched round");
    assert.equal(chains[0], "provA/modelA", "round 1 serves the initial model");
    assert.equal(chains[1], "provB/modelB", "round 2 serves the switched model");
  });

  it("re-merges invocation params for the round after the switch", async () => {
    const sessions = createSessionStore(db);
    sessions.update(SESSION_ID, {
      modelSelection: { model: "provA/modelA", temperature: 0.1 },
    });

    const temperatures: (number | undefined)[] = [];
    const createToolCallingClient = (() => {
      const isInitial = chains0IsInitial();
      return {
        async completeWithTools(req: { temperature?: number }) {
          temperatures.push(req.temperature);
          if (isInitial) {
            sessions.update(SESSION_ID, {
              modelSelection: { model: "provB/modelB", temperature: 0.9 },
            });
            return {
              content: "INVOCATION_1",
              toolCalls: [{ id: "t1", name: "no-such-tool", arguments: "{}" }],
              usedModel: "modelA",
              usedProviderId: "provA",
              degraded: false,
            };
          }
          return {
            content: "INVOCATION_2",
            toolCalls: [],
            usedModel: "modelB",
            usedProviderId: "provB",
            degraded: false,
          };
        },
      };
      function chains0IsInitial(): boolean {
        return temperatures.length === 0;
      }
    }) as Parameters<typeof executeSessionAgentTurn>[0]["createToolCallingClient"];

    const result = await executeSessionAgentTurn(buildInput({ createToolCallingClient }));

    assert.equal(result.outcome, "completed");
    assert.deepEqual(temperatures, [0.1, 0.9], "round 2 uses the new invocation params");
  });

  it("swaps the context window used for the round after the switch", async () => {
    const sessions = createSessionStore(db);
    sessions.update(SESSION_ID, { modelSelection: { model: "provA/modelA" } });

    const windows: (number | undefined)[] = [];
    const createToolCallingClient = (() => {
      const isInitial = windows.length === 0;
      return {
        async completeWithTools() {
          if (isInitial) {
            sessions.update(SESSION_ID, { modelSelection: { model: "provB/modelB" } });
            return {
              content: "WINDOW_1",
              toolCalls: [{ id: "t1", name: "no-such-tool", arguments: "{}" }],
              usedModel: "modelA",
              usedProviderId: "provA",
              degraded: false,
              usage: { inputTokens: 10, outputTokens: 5, contextWindowTokens: 200_000 },
            };
          }
          return {
            content: "WINDOW_2",
            toolCalls: [],
            usedModel: "modelB",
            usedProviderId: "provB",
            degraded: false,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      };
    }) as Parameters<typeof executeSessionAgentTurn>[0]["createToolCallingClient"];

    const result = await executeSessionAgentTurn(
      buildInput({
        createToolCallingClient,
        events: {
          onContextUpdate: (update) => windows.push(update.totalTokens),
        },
      }),
    );

    assert.equal(result.outcome, "completed");
    assert.equal(result.latestAssistantText, "WINDOW_2");
    // Round 2 reports no provider window, so the status bar falls back to the
    // turn's resolved ctxWindowTokens — which must be the switched model's.
    assert.equal(windows[1], 90_000, "round 2 falls back to the new model's window");
  });
});
