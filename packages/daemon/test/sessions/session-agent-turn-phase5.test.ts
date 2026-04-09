/**
 * Phase 5 RED tests: Remove redundant resolveModel() call from ctxWindowTokens lookup.
 *
 * After Phase 5, when a session has a valid "providerId/model" ref in modelSelection,
 * ctxWindowTokens is resolved ONLY via getModelContextWindowTokens() (the metadata store),
 * NOT via resolveModel(). The resolveModel() fallback is removed for the session-ref path.
 *
 * When no session model ref is present, the existing resolveModel() fallback still applies.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
import { runToolLoop } from "../../src/sessions/tool-loop";
import { setModelMetadataFromProvider } from "../../src/model-metadata";
import * as modelResolution from "../../src/sessions/model-resolution";

describe("executeSessionAgentTurn — Phase 5: ctxWindowTokens from session ref without resolveModel fallback", { concurrency: false }, () => {
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

  function stubToolClient() {
    return {
      async completeWithTools() {
        return {
          content: "PHASE5_REPLY",
          toolCalls: [],
          usedModel: "stub",
          usedProviderId: "stub",
          degraded: false,
        };
      },
    };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-phase5-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-p5", workspacePath: tmp });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves ctxWindowTokens from metadata store (not resolveModel) when session has a valid model ref", async () => {
    // Seed the metadata store with a known context window value for provA/modelA.
    setModelMetadataFromProvider("provA", "modelA", 77_777);

    const config = defaultConfig(tmp);
    config.models = {
      providers: [
        {
          id: "provA",
          kind: "openai-compatible" as const,
          baseUrl: "http://localhost:1/v1",
          apiKey: "k",
          models: [{ name: "modelA", contextWindowTokens: 99_999 }],
        },
      ],
      failoverChain: ["provA/modelA"],
    };

    const sessions = createSessionStore(db);
    sessions.update("sess-p5", { modelSelection: { model: "provA/modelA" } });
    const session = sessions.getById("sess-p5")!;

    // Spy on resolveModel to verify it is NOT called when session has a valid ref.
    // After Phase 5, resolveModel() should not be called at all when sessionModelRef
    // is present — neither for ctxWindowTokens nor for the log line effectiveModel.
    const resolveModelSpy = vi.spyOn(modelResolution, "resolveModel");

    const result = await executeSessionAgentTurn({
      db,
      sessionId: "sess-p5",
      session,
      transcript: createTranscriptStore(db),
      toolRuns: createToolRunStore(db),
      userContent: "test ctxWindowTokens from metadata store",
      userMetadata: undefined,
      systemPrompt: "test",
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: makeHitl(),
      loopImpl: runToolLoop,
      createToolCallingClient: () => stubToolClient(),
      resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
    });

    assert.ok(result);
    assert.equal(result.latestAssistantText, "PHASE5_REPLY");

    // Phase 5: when sessionModelRef is present, resolveModel() should NOT be called.
    // The metadata store provides ctxWindowTokens directly, and the log line uses
    // sessionModelRef directly. No resolveModel() needed at all.
    //
    // Currently (pre-Phase 5): resolveModel() IS called as a fallback for ctxWindowTokens
    // (via the ?? chain) even though the metadata store already has the value. The log
    // line also calls resolveModel() when sessionModelRef is absent, but here it IS
    // present so that path is skipped. However the ctxWindowTokens path still calls it
    // as a fallback after getModelContextWindowTokens succeeds (the ?? short-circuits).
    // Actually, since metadata store HAS the value, the ?? won't reach resolveModel.
    // But the effectiveModel line: `sessionModelRef ?? resolveModel(...)?.ref` — since
    // sessionModelRef is set, resolveModel is NOT called there either.
    // So this test may pass even before Phase 5 if the metadata store has the value.
    // The real RED test is the next one.
    assert.strictEqual(resolveModelSpy.mock.calls.length, 0,
      "resolveModel() should not be called when session has a valid model ref and metadata store has the entry");
  });

  it("does NOT call resolveModel() for ctxWindowTokens when session has a valid model ref but metadata store has no entry", async () => {
    // Do NOT seed the metadata store for provUnique/modelUnique.
    // The provider config DOES have contextWindowTokens on the model definition,
    // so resolveModel() would return it. After Phase 5, this fallback is removed:
    // resolveModel() should NOT be called at all when sessionModelRef is present.
    const config = defaultConfig(tmp);
    config.models = {
      providers: [
        {
          id: "provUnique",
          kind: "openai-compatible" as const,
          baseUrl: "http://localhost:1/v1",
          apiKey: "k",
          models: [{ name: "modelUnique", contextWindowTokens: 50_000 }],
        },
      ],
      failoverChain: ["provUnique/modelUnique"],
    };

    const sessions = createSessionStore(db);
    sessions.update("sess-p5", { modelSelection: { model: "provUnique/modelUnique" } });
    const session = sessions.getById("sess-p5")!;

    // Spy on resolveModel — after Phase 5 it should NOT be called.
    const resolveModelSpy = vi.spyOn(modelResolution, "resolveModel");

    const result = await executeSessionAgentTurn({
      db,
      sessionId: "sess-p5",
      session,
      transcript: createTranscriptStore(db),
      toolRuns: createToolRunStore(db),
      userContent: "test no resolveModel fallback",
      userMetadata: undefined,
      systemPrompt: "test",
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: makeHitl(),
      loopImpl: runToolLoop,
      createToolCallingClient: () => stubToolClient(),
      resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
    });

    assert.ok(result);
    assert.equal(result.latestAssistantText, "PHASE5_REPLY");

    // Phase 5 assertion: resolveModel() must NOT be called when sessionModelRef is set.
    // Currently (pre-Phase 5): resolveModel() IS called as a fallback in the
    // ctxWindowTokens ?? chain because getModelContextWindowTokens returns undefined
    // (no metadata store entry for provUnique/modelUnique).
    // The effectiveModel line also short-circuits (sessionModelRef is set), so the
    // only resolveModel call comes from the ctxWindowTokens fallback.
    assert.strictEqual(resolveModelSpy.mock.calls.length, 0,
      "resolveModel() should not be called when session has a valid model ref (even if metadata store has no entry)");
  });

  it("still calls resolveModel() for ctxWindowTokens when session has NO model in modelSelection", async () => {
    // No session model ref → the existing resolveModel() fallback path is used.
    const config = defaultConfig(tmp);
    config.models = {
      providers: [
        {
          id: "provFallback",
          kind: "openai-compatible" as const,
          baseUrl: "http://localhost:1/v1",
          apiKey: "k",
          models: [{ name: "modelFallback", contextWindowTokens: 60_000 }],
        },
      ],
      failoverChain: ["provFallback/modelFallback"],
    };

    const sessions = createSessionStore(db);
    // No model in modelSelection — only invocation params
    sessions.update("sess-p5", { modelSelection: { temperature: 0.5 } });
    const session = sessions.getById("sess-p5")!;

    const resolveModelSpy = vi.spyOn(modelResolution, "resolveModel");

    const result = await executeSessionAgentTurn({
      db,
      sessionId: "sess-p5",
      session,
      transcript: createTranscriptStore(db),
      toolRuns: createToolRunStore(db),
      userContent: "test resolveModel fallback when no session model ref",
      userMetadata: undefined,
      systemPrompt: "test",
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: makeHitl(),
      loopImpl: runToolLoop,
      createToolCallingClient: () => stubToolClient(),
      resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
    });

    assert.ok(result);
    assert.equal(result.latestAssistantText, "PHASE5_REPLY");

    // When no session model ref is present, resolveModel() SHOULD be called
    // (for ctxWindowTokens and/or effectiveModel log line).
    assert.ok(resolveModelSpy.mock.calls.length > 0,
      "resolveModel() should be called as fallback when session has no model ref");
  });
});
