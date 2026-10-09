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

/** Returns the modelSelection recorded in the first sessions.update call that carries one. */
function recordedModelSelection(
  sessions: ReturnType<typeof fakeSessionStore>,
): Record<string, unknown> | undefined {
  const updateCall = sessions.updateCalls.find((call) => {
    const data = call[1] as Record<string, unknown>;
    return data.modelSelection !== undefined;
  });
  if (!updateCall) return undefined;
  return (updateCall[1] as Record<string, unknown>).modelSelection as Record<string, unknown>;
}

/** Builds a resolver getter for a given config (agents.list.<id>.subagentModel + global). */
function makeResolver(config: {
  perAgent?: Record<string, { subagentModel?: string }>;
  global?: string;
}) {
  return (parentSessionId: string): string | undefined => {
    const agentId = parentSessionId.split(":")[1];
    const perAgent = agentId ? config.perAgent?.[agentId]?.subagentModel : undefined;
    return perAgent ?? config.global;
  };
}

// ---------------------------------------------------------------------------
// createDaemonSpawnAdapter — owning-agent subagentModel resolution
// ---------------------------------------------------------------------------

describe("createDaemonSpawnAdapter owning-agent subagentModel resolution", () => {
  it("uses the owning agent's subagentModel for a task spawned under that agent's session", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:researcher:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      resolveSubagentModel: makeResolver({
        perAgent: { researcher: { subagentModel: "provider-a/researcher-model" } },
        global: "provider-a/global-model",
      }),
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "Do something",
      replyTo: "agent:researcher:discord:channel:abc",
      timeoutMs: 30_000,
    });

    const modelSelection = recordedModelSelection(sessions);
    assert.ok(modelSelection, "modelSelection should be set");
    assert.equal(modelSelection.model, "provider-a/researcher-model");
  });

  it("falls back to the global agents.subagentModel when the owning agent has no override", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:plain:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      resolveSubagentModel: makeResolver({
        perAgent: { researcher: { subagentModel: "provider-b/researcher-model" } },
        global: "provider-a/global-model",
      }),
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "Do something",
      replyTo: "agent:plain:discord:channel:abc",
      timeoutMs: 30_000,
    });

    const modelSelection = recordedModelSelection(sessions);
    assert.ok(modelSelection, "modelSelection should be set");
    assert.equal(modelSelection.model, "provider-a/global-model");
  });

  it("lets per-task model_options.model win over the owning agent's subagentModel", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:researcher:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      resolveSubagentModel: makeResolver({
        perAgent: { researcher: { subagentModel: "provider-a/researcher-model" } },
        global: "provider-a/global-model",
      }),
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "Do something",
      replyTo: "agent:researcher:discord:channel:abc",
      timeoutMs: 30_000,
      modelOptions: { model: "provider-x/task-override" },
    });

    const modelSelection = recordedModelSelection(sessions);
    assert.ok(modelSelection, "modelSelection should be set");
    assert.equal(modelSelection.model, "provider-x/task-override");
  });

  it("sets no model when neither the owning agent nor global config has a subagentModel", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:quiet:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      resolveSubagentModel: makeResolver({}),
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "Do something",
      replyTo: "agent:quiet:discord:channel:abc",
      timeoutMs: 30_000,
    });

    for (const call of sessions.updateCalls) {
      const data = call[1] as Record<string, unknown>;
      assert.equal(
        data.modelSelection,
        undefined,
        "modelSelection should not be set when no subagentModel is configured",
      );
    }
  });

  it("resolves from req.replyTo when parentSessionId is omitted", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      runSessionModelTurn: turn.fn,
      resolveSubagentModel: makeResolver({
        perAgent: { analyst: { subagentModel: "provider-c/analyst-model" } },
        global: "provider-a/global-model",
      }),
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "Do something",
      replyTo: "agent:analyst:discord:channel:abc",
      timeoutMs: 30_000,
    });

    const modelSelection = recordedModelSelection(sessions);
    assert.ok(modelSelection, "modelSelection should be set");
    assert.equal(modelSelection.model, "provider-c/analyst-model");
  });

  it("still applies the deprecated fixed subagentModel when no resolver is provided", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:researcher:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      subagentModel: "provider-a/legacy-model",
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "Do something",
      replyTo: "agent:researcher:discord:channel:abc",
      timeoutMs: 30_000,
    });

    const modelSelection = recordedModelSelection(sessions);
    assert.ok(modelSelection, "modelSelection should be set");
    assert.equal(modelSelection.model, "provider-a/legacy-model");
  });
});
