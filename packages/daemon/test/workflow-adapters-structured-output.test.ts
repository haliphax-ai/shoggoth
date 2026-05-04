import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createDaemonSpawnAdapter, type DaemonSpawnAdapterDeps } from "../src/workflow-adapters.js";

// ---------------------------------------------------------------------------
// Helpers: minimal fakes for daemon internals
// ---------------------------------------------------------------------------

function fakeSessionManager(overrides: Partial<DaemonSpawnAdapterDeps["sessionManager"]> = {}) {
  return {
    spawn:
      overrides.spawn ??
      (async () => ({
        sessionId: "agent:main:discord:channel:abc:child-uuid",
        agentToken: "tok",
        agentTokenEnvName: "SHOGGOTH_AGENT_TOKEN" as const,
      })),
    kill: overrides.kill ?? (() => {}),
  };
}

function fakeSessionStore() {
  const updateCalls: unknown[][] = [];
  return {
    getById: () => undefined,
    update: (...args: unknown[]) => {
      updateCalls.push(args);
    },
    create: () => {},
    delete: () => {},
    list: () => [],
    updateCalls,
  };
}

function fakeRunSessionModelTurn() {
  const calls: unknown[] = [];
  const fn = async (input: unknown) => {
    calls.push(input);
    return { latestAssistantText: "done", failoverMeta: null };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// createDaemonSpawnAdapter — responseSchema forwarding
// ---------------------------------------------------------------------------

describe("createDaemonSpawnAdapter responseSchema forwarding", () => {
  it("forwards responseSchema into the spawned session model_selection via sessions.update", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:channel:abc",
      runSessionModelTurn: turn.fn,
    });

    const responseSchema = {
      schema: {
        type: "object",
        properties: {
          total_errors: { type: "number" },
          categories: { type: "array" },
        },
        required: ["total_errors", "categories"],
        additionalProperties: false,
      },
    };

    await adapter.spawn({
      taskId: 1,
      prompt: "Analyze logs",
      replyTo: "agent:main:discord:channel:abc",
      timeoutMs: 30_000,
      responseSchema,
    } as any); // responseSchema isn't on SpawnRequest yet

    // The sessions.update call should include modelSelection with responseSchema.
    // This will FAIL because the adapter doesn't forward responseSchema yet.
    const updateCall = sessions.updateCalls.find((call) => {
      const data = call[1] as Record<string, unknown>;
      return data.modelSelection !== undefined;
    });

    assert.ok(
      updateCall,
      "sessions.update should have been called with modelSelection containing responseSchema",
    );

    const updateData = updateCall![1] as Record<string, unknown>;
    const modelSelection = updateData.modelSelection as Record<string, unknown>;
    assert.ok(modelSelection, "modelSelection should be defined");
    assert.deepEqual(modelSelection.responseSchema, responseSchema);
  });

  it("does not set modelSelection.responseSchema when spawn request has no responseSchema", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:channel:abc",
      runSessionModelTurn: turn.fn,
    });

    await adapter.spawn({
      taskId: 2,
      prompt: "Simple task",
      replyTo: "agent:main:discord:channel:abc",
      timeoutMs: 30_000,
    });

    // Verify that no update call sets a responseSchema in modelSelection
    for (const call of sessions.updateCalls) {
      const data = call[1] as Record<string, unknown>;
      if (data.modelSelection) {
        const ms = data.modelSelection as Record<string, unknown>;
        assert.equal(
          ms.responseSchema,
          undefined,
          "modelSelection.responseSchema should not be set when not provided",
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// createDaemonSpawnAdapter — subagentModel forwarding
// ---------------------------------------------------------------------------

describe("createDaemonSpawnAdapter subagentModel forwarding", () => {
  it("passes subagentModel as modelSelection.model to sessions.update", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      subagentModel: "kiro/minimax-m2.5",
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "Do something",
      replyTo: "agent:main:discord:channel:abc",
      timeoutMs: 30_000,
    });

    const updateCall = sessions.updateCalls.find((call) => {
      const data = call[1] as Record<string, unknown>;
      return data.modelSelection !== undefined;
    });

    assert.ok(
      updateCall,
      "sessions.update should have been called with modelSelection containing model",
    );

    const updateData = updateCall![1] as Record<string, unknown>;
    const modelSelection = updateData.modelSelection as Record<string, unknown>;
    assert.ok(modelSelection, "modelSelection should be defined");
    assert.equal(modelSelection.model, "kiro/minimax-m2.5");
  });

  it("merges subagentModel and responseSchema into a single modelSelection", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      subagentModel: "kiro/minimax-m2.5",
    });

    const responseSchema = {
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
        additionalProperties: false,
      },
    };

    await adapter.spawn({
      taskId: 1,
      prompt: "Count items",
      replyTo: "agent:main:discord:channel:abc",
      timeoutMs: 30_000,
      responseSchema,
    } as any);

    const updateCall = sessions.updateCalls.find((call) => {
      const data = call[1] as Record<string, unknown>;
      return data.modelSelection !== undefined;
    });

    assert.ok(updateCall, "sessions.update should have been called with modelSelection");

    const updateData = updateCall![1] as Record<string, unknown>;
    const modelSelection = updateData.modelSelection as Record<string, unknown>;
    assert.equal(modelSelection.model, "kiro/minimax-m2.5");
    assert.deepEqual(modelSelection.responseSchema, responseSchema);
  });

  it("does not set modelSelection when neither subagentModel nor responseSchema is provided", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:channel:abc",
      runSessionModelTurn: turn.fn,
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "Simple task",
      replyTo: "agent:main:discord:channel:abc",
      timeoutMs: 30_000,
    });

    for (const call of sessions.updateCalls) {
      const data = call[1] as Record<string, unknown>;
      assert.equal(
        data.modelSelection,
        undefined,
        "modelSelection should not be set when neither subagentModel nor responseSchema is provided",
      );
    }
  });
});
