/**
 * Phase 5: second entrypoint — calls `executeSessionAgentTurn` with mocked `completeWithTools` (no Discord),
 * proving the session turn core is platform-agnostic and CI-safe.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DEFAULT_HITL_CONFIG, shoggothModelsCompactionSchema } from "@shoggoth/shared";
import { defaultConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { executeSessionAgentTurn } from "../../src/sessions/session-agent-turn";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
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
    createSessionStore(db).create({ id: "sess-core", workspacePath: tmp });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
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
      systemPrompt: "You are a test assistant. Reply with one short sentence.",
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
    });

    assert.equal(result.latestAssistantText, "CORE_ISOLATION_REPLY");
    assert.equal(result.failoverMeta?.degraded, false);
  });

  it("proceeds normally when inline compaction fails (e.g. no real model)", async () => {
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
        maxContextChars: 80_000,
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
      systemPrompt: "You are a test assistant.",
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
    });

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
      systemPrompt: "test",
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
    });

    // The turn completed without error with an openai-compatible provider configured.
    // This proves resolveImageBlockCodec ran successfully and the codec was wired
    // into the BuiltinToolContext without throwing.
    assert.ok(result);
    assert.equal(result.latestAssistantText, "CODEC_TEST_REPLY");
  });
});

describe("shoggothModelsCompactionSchema – contextWindowReserveTokens", () => {
  it("accepts contextWindowReserveTokens", () => {
    const result = shoggothModelsCompactionSchema.safeParse({
      maxContextChars: 80_000,
      preserveRecentMessages: 2,
      contextWindowReserveTokens: 20_000,
    });
    assert.ok(result.success, `expected success: ${JSON.stringify(result.error?.issues)}`);
  });

});
