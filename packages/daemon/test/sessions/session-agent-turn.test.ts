/**
 * Phase 5: second entrypoint — calls `executeSessionAgentTurn` with mocked `completeWithTools` (no Discord),
 * proving the session turn core is platform-agnostic and CI-safe.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DEFAULT_HITL_CONFIG } from "@shoggoth/shared";
import { defaultConfig } from "@shoggoth/shared";
import type { ShoggothModelsConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { executeSessionAgentTurn } from "../../src/sessions/session-agent-turn";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { buildSessionSystemContext } from "../../src/sessions/session-system-prompt";
import * as SystemPromptModule from "../../src/sessions/session-system-prompt";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";

describe("executeSessionAgentTurn (no Discord)", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-turn-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({
      id: "sess-core",
      workspacePath: tmp,
      systemContextToken: "test-token",
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("runs builtin-only MCP context and returns assistant text", async () => {
    const config = defaultConfig(tmp);
    const sessions = createSessionStore(db);
    const session = sessions.getById("sess-core");
    assert.ok(session);
    const transcript = createTranscriptStore(db);
    const toolRuns = createToolRunStore(db);
    const hitlStack = createHitlPendingResolutionStack(db);
    const builtin = buildBuiltinOnlySessionMcpToolContext();

    const result = await executeSessionAgentTurn({
      db,
      sessionId: "sess-core",
      session: session!,
      transcript,
      toolRuns,
      userContent: "hello from isolation test",
      userMetadata: { source: "session-agent-turn.test" },
      // Phase 2: systemPrompt is removed from input
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: {
        bypassUpTo: "safe",
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: hitlStack.waitForHitlResolution,
      },
      loopImpl: runToolLoop,
      createToolCallingClient: () => ({
        async completeWithTools() {
          return {
            content: "CORE_ISOLATION_REPLY",
            toolCalls: [],
            usedModel: "stub",
            usedProviderId: "stub",
            degraded: false,
          };
        },
      }),
      resolveMcpContext: async () => builtin,
    } as any); // Cast to any for RED phase

    assert.equal(result.latestAssistantText, "CORE_ISOLATION_REPLY");
    assert.equal(result.failoverMeta?.degraded, false);
  });

  it("proceeds normally when mid-turn compaction fails (e.g. no real model)", async () => {
    const config = defaultConfig(tmp);
    // Configure a model with a tiny context window so the threshold is exceeded.
    config.models = {
      providers: [
        {
          id: "tiny",
          kind: "openai-compatible" as const,
          baseUrl: "http://localhost:1/v1",
          apiKey: "fake",
        },
      ],
      failoverChain: [{ providerId: "tiny", model: "m", contextWindowTokens: 100 }],
      compaction: {
        preserveRecentMessages: 2,
        contextWindowReserveTokens: 99_999, // reserve larger than window → triggers immediately
      },
    };

    const sessions = createSessionStore(db);
    const session = sessions.getById("sess-core");
    assert.ok(session);
    const transcript = createTranscriptStore(db);
    const toolRuns = createToolRunStore(db);
    const hitlStack = createHitlPendingResolutionStack(db);
    const builtin = buildBuiltinOnlySessionMcpToolContext();

    const result = await executeSessionAgentTurn({
      db,
      sessionId: "sess-core",
      session: session!,
      transcript,
      toolRuns,
      userContent: "trigger compaction test",
      userMetadata: undefined,
      // Phase 2: systemPrompt is removed from input
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: {
        bypassUpTo: "safe",
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: hitlStack.waitForHitlResolution,
      },
      loopImpl: runToolLoop,
      createToolCallingClient: () => ({
        async completeWithTools() {
          return {
            content: "COMPACTION_FALLTHROUGH",
            toolCalls: [],
            usedModel: "m",
            usedProviderId: "tiny",
            degraded: false,
          };
        },
      }),
      resolveMcpContext: async () => builtin,
    } as any);

    // Compaction should have failed (no real model endpoint) but the turn
    // should still complete successfully.
    assert.equal(result.latestAssistantText, "COMPACTION_FALLTHROUGH");
  });

  it("wires imageBlockCodec into BuiltinToolContext when provider is configured", async () => {
    const config = defaultConfig(tmp);
    // Configure an openai-compatible provider so the codec resolves.
    config.models = {
      providers: [
        {
          id: "test-oai",
          kind: "openai-compatible" as const,
          baseUrl: "http://localhost:1234/v1",
          apiKey: "test-key",
        },
      ],
      failoverChain: [{ providerId: "test-oai", model: "gpt-test" }],
    };

    const sessions = createSessionStore(db);
    const session = sessions.getById("sess-core");
    assert.ok(session);
    const transcript = createTranscriptStore(db);
    const toolRuns = createToolRunStore(db);
    const hitlStack = createHitlPendingResolutionStack(db);
    const builtin = buildBuiltinOnlySessionMcpToolContext();

    // Use the real loopImpl so the model client writes to the transcript.
    const result = await executeSessionAgentTurn({
      db,
      sessionId: "sess-core",
      session: session!,
      transcript,
      toolRuns,
      userContent: "test codec wiring",
      userMetadata: undefined,
      // Phase 2: systemPrompt is removed from input
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: {
        bypassUpTo: "safe",
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: hitlStack.waitForHitlResolution,
      },
      loopImpl: runToolLoop,
      createToolCallingClient: () => ({
        async completeWithTools() {
          return {
            content: "CODEC_TEST_REPLY",
            toolCalls: [],
            usedModel: "gpt-test",
            usedProviderId: "test-oai",
            degraded: false,
          };
        },
      }),
      resolveMcpContext: async () => builtin,
    } as any);

    // The turn completed without error with an openai-compatible provider configured.
    // This proves resolveImageBlockCodec ran successfully and the codec was wired
    // into the BuiltinToolContext without throwing.
    assert.ok(result);
    assert.equal(result.latestAssistantText, "CODEC_TEST_REPLY");
  });

  it("swallows tool loop errors by default and returns partial output", async () => {
    const config = defaultConfig(tmp);
    const sessions = createSessionStore(db);
    const session = sessions.getById("sess-core");
    assert.ok(session);
    const transcript = createTranscriptStore(db);
    const toolRuns = createToolRunStore(db);
    const hitlStack = createHitlPendingResolutionStack(db);
    const builtin = buildBuiltinOnlySessionMcpToolContext();

    const result = await executeSessionAgentTurn({
      db,
      sessionId: "sess-core",
      session: session!,
      transcript,
      toolRuns,
      userContent: "trigger error test",
      userMetadata: undefined,
      // Phase 2: systemPrompt is removed from input
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: {
        bypassUpTo: "safe",
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: hitlStack.waitForHitlResolution,
      },
      loopImpl: runToolLoop,
      createToolCallingClient: () => ({
        async completeWithTools() {
          throw new Error("Bad Gateway");
        },
      }),
      resolveMcpContext: async () => builtin,
    } as any);

    // Error is swallowed; partial output returned with error message fallback
    assert.ok(result.latestAssistantText.includes("Bad Gateway"));
  });

  it("re-throws tool loop errors when throwOnError is true", async () => {
    const config = defaultConfig(tmp);
    const sessions = createSessionStore(db);
    const session = sessions.getById("sess-core");
    assert.ok(session);
    const transcript = createTranscriptStore(db);
    const toolRuns = createToolRunStore(db);
    const hitlStack = createHitlPendingResolutionStack(db);
    const builtin = buildBuiltinOnlySessionMcpToolContext();

    await assert.rejects(
      () =>
        executeSessionAgentTurn({
          db,
          sessionId: "sess-core",
          session: session!,
          transcript,
          toolRuns,
          userContent: "trigger error test",
          userMetadata: undefined,
          // Phase 2: systemPrompt is removed from input
          env: process.env,
          config,
          policyEngine: createPolicyEngine(config.policy),
          getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
          hitl: {
            bypassUpTo: "safe",
            pending: hitlStack.pending,
            clock: { nowMs: () => Date.now() },
            newPendingId: () => randomUUID(),
            waitForHitlResolution: hitlStack.waitForHitlResolution,
          },
          loopImpl: runToolLoop,
          createToolCallingClient: () => ({
            async completeWithTools() {
              throw new Error("Bad Gateway");
            },
          }),
          resolveMcpContext: async () => builtin,
          throwOnError: true,
        } as any),
      { message: "Bad Gateway" },
    );
  });
});

/**
 * Phase 3 RED tests: executeSessionAgentTurn should read the primary model
 * from the session row (via getSessionPrimaryModelRef) instead of re-deriving
 * it from config. These tests capture the `models` arg passed to
 * createToolCallingClient and assert on the failover chain shape.
 */
describe(
  "executeSessionAgentTurn — Phase 3: session row as primary model source",
  { concurrency: false },
  () => {
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
            content: "PHASE3_REPLY",
            toolCalls: [],
            usedModel: "stub",
            usedProviderId: "stub",
            degraded: false,
          };
        },
      };
    }

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "shoggoth-phase3-"));
      const dbPath = join(tmp, "s.db");
      db = new Database(dbPath);
      db.pragma("foreign_keys = ON");
      migrate(db, defaultMigrationsDir());
      createSessionStore(db).create({
        id: "sess-p3",
        workspacePath: tmp,
        systemContextToken: "test-token",
      });
    });

    afterEach(() => {
      db.close();
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    it("prepends session modelSelection.model to the failover chain (deduped)", async () => {
      const config = defaultConfig(tmp);
      config.models = {
        providers: [
          {
            id: "provA",
            kind: "openai-compatible" as const,
            baseUrl: "http://localhost:1/v1",
            apiKey: "k",
          },
          {
            id: "provB",
            kind: "anthropic-messages" as const,
            baseUrl: "http://localhost:2",
            apiKey: "k",
          },
        ],
        failoverChain: ["provA/modelA", "provB/modelB"],
      };

      const sessions = createSessionStore(db);
      sessions.update("sess-p3", {
        modelSelection: { model: "provB/modelB", temperature: 0.5 },
      });
      const session = sessions.getById("sess-p3")!;

      let capturedModels: ShoggothModelsConfig | undefined;
      await executeSessionAgentTurn({
        db,
        sessionId: "sess-p3",
        session,
        transcript: createTranscriptStore(db),
        toolRuns: createToolRunStore(db),
        userContent: "test",
        userMetadata: undefined,
        // Phase 2: systemPrompt is removed from input
        env: process.env,
        config,
        policyEngine: createPolicyEngine(config.policy),
        getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
        hitl: makeHitl(),
        loopImpl: runToolLoop,
        createToolCallingClient: (models) => {
          capturedModels = models;
          return stubToolClient();
        },
        resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
      } as any);

      assert.ok(capturedModels, "createToolCallingClient should have been called");
      const chain = capturedModels!.failoverChain!;
      // Phase 3: session model ref must be first in the chain
      assert.strictEqual(chain[0], "provB/modelB", "session model ref should be first in chain");
      // It must be deduped — only one occurrence
      const count = chain.filter((e: unknown) => e === "provB/modelB").length;
      assert.strictEqual(count, 1, "session model ref should appear exactly once (deduped)");
    });

    it("falls back to config chain when session has no model in modelSelection", async () => {
      const config = defaultConfig(tmp);
      config.models = {
        providers: [
          {
            id: "provA",
            kind: "openai-compatible" as const,
            baseUrl: "http://localhost:1/v1",
            apiKey: "k",
          },
        ],
        failoverChain: ["provA/modelA"],
      };

      const sessions = createSessionStore(db);
      sessions.update("sess-p3", { modelSelection: { temperature: 0.7 } });
      const session = sessions.getById("sess-p3")!;

      let capturedModels: ShoggothModelsConfig | undefined;
      await executeSessionAgentTurn({
        db,
        sessionId: "sess-p3",
        session,
        transcript: createTranscriptStore(db),
        toolRuns: createToolRunStore(db),
        userContent: "test",
        userMetadata: undefined,
        // Phase 2: systemPrompt is removed from input
        env: process.env,
        config,
        policyEngine: createPolicyEngine(config.policy),
        getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
        hitl: makeHitl(),
        loopImpl: runToolLoop,
        createToolCallingClient: (models) => {
          capturedModels = models;
          return stubToolClient();
        },
        resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
      } as any);

      assert.ok(capturedModels);
      const chain = capturedModels!.failoverChain!;
      assert.strictEqual(
        chain[0],
        "provA/modelA",
        "config chain should be used as-is when no session model",
      );
      assert.strictEqual(chain.length, 1, "chain length should match config");
    });

    it("ignores bare model names (no /) in session modelSelection", async () => {
      const config = defaultConfig(tmp);
      config.models = {
        providers: [
          {
            id: "provA",
            kind: "openai-compatible" as const,
            baseUrl: "http://localhost:1/v1",
            apiKey: "k",
          },
        ],
        failoverChain: ["provA/modelA"],
      };

      const sessions = createSessionStore(db);
      sessions.update("sess-p3", {
        modelSelection: { model: "bare-model-name" },
      });
      const session = sessions.getById("sess-p3")!;

      let capturedModels: ShoggothModelsConfig | undefined;
      await executeSessionAgentTurn({
        db,
        sessionId: "sess-p3",
        session,
        transcript: createTranscriptStore(db),
        toolRuns: createToolRunStore(db),
        userContent: "test",
        userMetadata: undefined,
        // Phase 2: systemPrompt is removed from input
        env: process.env,
        config,
        policyEngine: createPolicyEngine(config.policy),
        getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
        hitl: makeHitl(),
        loopImpl: runToolLoop,
        createToolCallingClient: (models) => {
          capturedModels = models;
          return stubToolClient();
        },
        resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
      } as any);

      assert.ok(capturedModels);
      const chain = capturedModels!.failoverChain!;
      const hasBare = chain.some((e: unknown) => e === "bare-model-name");
      assert.strictEqual(hasBare, false, "bare model name should not appear in failover chain");
      assert.strictEqual(chain[0], "provA/modelA", "config chain should be used unchanged");
    });

    it("resolves image block codec from session primary provider, not config chain head", async () => {
      const config = defaultConfig(tmp);
      config.models = {
        providers: [
          {
            id: "provOai",
            kind: "openai-compatible" as const,
            baseUrl: "http://localhost:1/v1",
            apiKey: "k",
          },
          {
            id: "provAnth",
            kind: "anthropic-messages" as const,
            baseUrl: "http://localhost:2",
            apiKey: "k",
          },
        ],
        failoverChain: ["provOai/gpt-test", "provAnth/claude-test"],
      };

      const sessions = createSessionStore(db);
      // Session primary model is on the anthropic provider, but config chain head is openai
      sessions.update("sess-p3", {
        modelSelection: { model: "provAnth/claude-test" },
      });
      const session = sessions.getById("sess-p3")!;

      let capturedModels: ShoggothModelsConfig | undefined;
      await executeSessionAgentTurn({
        db,
        sessionId: "sess-p3",
        session,
        transcript: createTranscriptStore(db),
        toolRuns: createToolRunStore(db),
        userContent: "test codec",
        userMetadata: undefined,
        // Phase 2: systemPrompt is removed from input
        env: process.env,
        config,
        policyEngine: createPolicyEngine(config.policy),
        getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
        hitl: makeHitl(),
        loopImpl: runToolLoop,
        createToolCallingClient: (models) => {
          capturedModels = models;
          return stubToolClient();
        },
        resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
      } as any);

      assert.ok(capturedModels);
      const chain = capturedModels!.failoverChain!;
      // Phase 3: session model (anthropic) must be first so resolveImageBlockCodec
      // picks up anthropic-messages codec, not openai-compatible.
      assert.strictEqual(
        chain[0],
        "provAnth/claude-test",
        "session model should be first in chain so image codec resolves from anthropic provider",
      );
      const firstProviderId = (chain[0] as string).split("/")[0];
      const firstProvider = capturedModels!.providers!.find((p) => p.id === firstProviderId);
      assert.ok(firstProvider);
      assert.strictEqual(
        firstProvider!.kind,
        "anthropic-messages",
        "image codec should resolve from session provider kind (anthropic-messages), not config chain head (openai-compatible)",
      );
    });

    it("prepends session model even when it is absent from the config failover chain", async () => {
      const config = defaultConfig(tmp);
      config.models = {
        providers: [
          {
            id: "provA",
            kind: "openai-compatible" as const,
            baseUrl: "http://localhost:1/v1",
            apiKey: "k",
          },
          {
            id: "provB",
            kind: "anthropic-messages" as const,
            baseUrl: "http://localhost:2",
            apiKey: "k",
          },
        ],
        failoverChain: ["provA/modelA"],
      };

      const sessions = createSessionStore(db);
      // provB/modelB is NOT in the config chain
      sessions.update("sess-p3", { modelSelection: { model: "provB/modelB" } });
      const session = sessions.getById("sess-p3")!;

      let capturedModels: ShoggothModelsConfig | undefined;
      await executeSessionAgentTurn({
        db,
        sessionId: "sess-p3",
        session,
        transcript: createTranscriptStore(db),
        toolRuns: createToolRunStore(db),
        userContent: "test",
        userMetadata: undefined,
        // Phase 2: systemPrompt is removed from input
        env: process.env,
        config,
        policyEngine: createPolicyEngine(config.policy),
        getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
        hitl: makeHitl(),
        loopImpl: runToolLoop,
        createToolCallingClient: (models) => {
          capturedModels = models;
          return stubToolClient();
        },
        resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
      } as any);

      assert.ok(capturedModels);
      const chain = capturedModels!.failoverChain!;
      assert.strictEqual(chain.length, 2, "chain should have session model + config entry");
      assert.strictEqual(chain[0], "provB/modelB", "session model should be first");
      assert.strictEqual(chain[1], "provA/modelA", "config entry should follow");
    });

    it("passes correctly formatted modelLabel to buildSessionSystemContext", async () => {
      const config = defaultConfig(tmp);
      config.models = {
        providers: [{ id: "p1", kind: "openai-compatible", baseUrl: "b", apiKey: "k" }],
        failoverChain: ["p1/m1"],
      };
      const sessions = createSessionStore(db);
      sessions.update("sess-p3", { modelSelection: { model: "p-override/m-override" } });
      const session = sessions.getById("sess-p3")!;

      const buildSpy = vi.spyOn(SystemPromptModule, "buildSessionSystemContext");

      await executeSessionAgentTurn({
        db,
        sessionId: "sess-p3",
        session,
        transcript: createTranscriptStore(db),
        toolRuns: createToolRunStore(db),
        userContent: "test label",
        userMetadata: undefined,
        env: process.env,
        config,
        policyEngine: createPolicyEngine(config.policy),
        getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
        hitl: makeHitl(),
        loopImpl: runToolLoop,
        createToolCallingClient: () => stubToolClient(),
        resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
      } as any);

      const lastCall = buildSpy.mock.calls[buildSpy.mock.calls.length - 1];
      assert.strictEqual(lastCall[0].modelLabel, "m-override (provider: p-override)");
      buildSpy.mockRestore();
    });

    it("ignores malformed model refs (/model, provider/, empty) in session modelSelection", async () => {
      const config = defaultConfig(tmp);
      config.models = {
        providers: [
          {
            id: "provA",
            kind: "openai-compatible" as const,
            baseUrl: "http://localhost:1/v1",
            apiKey: "k",
          },
        ],
        failoverChain: ["provA/modelA"],
      };

      for (const badModel of ["/modelOnly", "providerOnly/", ""]) {
        const sessions = createSessionStore(db);
        sessions.update("sess-p3", { modelSelection: { model: badModel } });
        const session = sessions.getById("sess-p3")!;

        let capturedModels: ShoggothModelsConfig | undefined;
        await executeSessionAgentTurn({
          db,
          sessionId: "sess-p3",
          session,
          transcript: createTranscriptStore(db),
          toolRuns: createToolRunStore(db),
          userContent: `test malformed ${badModel}`,
          userMetadata: undefined,
          // Phase 2: systemPrompt is removed from input
          env: process.env,
          config,
          policyEngine: createPolicyEngine(config.policy),
          getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
          hitl: makeHitl(),
          loopImpl: runToolLoop,
          createToolCallingClient: (models) => {
            capturedModels = models;
            return stubToolClient();
          },
          resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
        } as any);

        assert.ok(capturedModels, `createToolCallingClient called for badModel="${badModel}"`);
        const chain = capturedModels!.failoverChain!;
        const hasBad = chain.some((e: unknown) => e === badModel);
        assert.strictEqual(
          hasBad,
          false,
          `malformed model "${badModel}" should not appear in failover chain`,
        );
        assert.strictEqual(
          chain[0],
          "provA/modelA",
          `config chain should be used unchanged for malformed model "${badModel}"`,
        );
      }
    });
  },
);
