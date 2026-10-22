/**
 * session_model model-switch guards: a switch mid-turn or while idle must be
 * rejected when the model is not resolvable in the session's effective models
 * config or when its context window cannot hold the session's estimated
 * context usage. Valid switches are accepted, and a switch that reduces the
 * context window cap posts a warning through the turn-surface banner system.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import { handleIntegrationControlOp, IntegrationOpError } from "../../src/control/integration-ops";
import type { IntegrationOpsContext } from "../../src/control/integration-ops";
import type { AuthenticatedPrincipal, WireRequest } from "@shoggoth/authn";
import { WIRE_VERSION } from "@shoggoth/authn";
import { DEFAULT_HITL_CONFIG, DEFAULT_POLICY_CONFIG, type ShoggothConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { incrementTokenUsage } from "../../src/sessions/session-stats-store";
import {
  registerActiveTurnSurface,
  _resetActiveTurnSurfaces,
} from "../../src/presentation/active-turn-surface";

const SESSION =
  "agent:test:session-model-guards:discord:channel:00000000-0000-0000-0000-000000000001";

function operatorPrincipal(): AuthenticatedPrincipal {
  return { kind: "operator", operatorId: "op-test" };
}

function makeConfig(): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: "/tmp/state.db",
    socketPath: "/tmp/c.sock",
    workspacesRoot: "/tmp/workspaces",
    secretsDirectory: "/tmp/secrets",
    inboundMediaRoot: "/tmp/media",
    configDirectory: "/tmp/config",
    hitl: DEFAULT_HITL_CONFIG,
    memory: { paths: ["memory"], embeddings: { enabled: false } },
    skills: { scanRoots: ["skills"], disabledIds: [] },
    plugins: [],
    mcp: { servers: {}, poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
    models: {
      providers: {
        provBig: {
          kind: "openai-compatible",
          baseUrl: "http://big.test/v1",
          apiKey: "k",
          models: {
            big: { contextWindowTokens: 200_000 },
            bigAlt: { contextWindowTokens: 200_000 },
          },
        },
        provMid: {
          kind: "openai-compatible",
          baseUrl: "http://mid.test/v1",
          apiKey: "k",
          models: { mid: { contextWindowTokens: 128_000 } },
        },
        provSmall: {
          kind: "openai-compatible",
          baseUrl: "http://small.test/v1",
          apiKey: "k",
          models: { small: { contextWindowTokens: 8_000 } },
        },
      },
      failoverChain: ["provBig/big"],
    },
  } as unknown as ShoggothConfig;
}

function makeReq(payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: "sm-guards",
    op: "session_model",
    payload,
  };
}

describe("session_model switch guards", () => {
  let db: Database.Database;

  function makeCtx(): IntegrationOpsContext {
    return {
      config: makeConfig(),
      stateDb: db,
      sessions: createSessionStore(db),
      recordIntegrationAudit: () => {},
    } as unknown as IntegrationOpsContext;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    sessions.create({ id: SESSION, workspacePath: "/w", status: "active" });
  });

  afterEach(() => {
    _resetActiveTurnSurfaces();
    db.close();
  });

  it("rejects a model that cannot be resolved in the session's models config", async () => {
    const ctx = makeCtx();
    await assert.rejects(
      () =>
        handleIntegrationControlOp(
          makeReq({ session_id: SESSION, model_selection: { model: "provMissing/nope" } }),
          operatorPrincipal(),
          ctx,
        ),
      (err: unknown) =>
        err instanceof IntegrationOpError &&
        err.code === "ERR_MODEL_NOT_FOUND" &&
        /provMissing/.test(err.message),
    );
    const row = ctx.sessions!.getById(SESSION);
    assert.equal(row?.modelSelection, undefined, "rejected switch must not persist");
  });

  it("rejects a model whose context window cannot hold the session's estimated usage", async () => {
    const ctx = makeCtx();
    incrementTokenUsage(db, SESSION, {
      inputTokens: 50_000,
      outputTokens: 100,
      contextFillTokens: 50_000,
    });
    await assert.rejects(
      () =>
        handleIntegrationControlOp(
          makeReq({ session_id: SESSION, model_selection: { model: "provSmall/small" } }),
          operatorPrincipal(),
          ctx,
        ),
      (err: unknown) =>
        err instanceof IntegrationOpError &&
        err.code === "ERR_CONTEXT_WINDOW_TOO_SMALL" &&
        /context window/.test(err.message),
    );
    const row = ctx.sessions!.getById(SESSION);
    assert.equal(row?.modelSelection, undefined, "rejected switch must not persist");
  });

  it("accepts a valid switch to a compatible model with a sufficient window", async () => {
    const ctx = makeCtx();
    incrementTokenUsage(db, SESSION, {
      inputTokens: 50_000,
      outputTokens: 100,
      contextFillTokens: 50_000,
    });
    const res = (await handleIntegrationControlOp(
      makeReq({ session_id: SESSION, model_selection: { model: "provBig/bigAlt" } }),
      operatorPrincipal(),
      ctx,
    )) as { ok: boolean; model_selection: { model: string } | null };
    assert.equal(res.ok, true);
    assert.equal(res.model_selection?.model, "provBig/bigAlt");
    const row = ctx.sessions!.getById(SESSION);
    assert.deepEqual(row?.modelSelection, { model: "provBig/bigAlt" });
  });

  it("allows an invocation-only update even when guards would apply to a model switch", async () => {
    const ctx = makeCtx();
    incrementTokenUsage(db, SESSION, {
      inputTokens: 50_000,
      outputTokens: 100,
      contextFillTokens: 50_000,
    });
    const res = (await handleIntegrationControlOp(
      makeReq({ session_id: SESSION, model_selection: { temperature: 0.7 } }),
      operatorPrincipal(),
      ctx,
    )) as { ok: boolean };
    assert.equal(res.ok, true);
    const row = ctx.sessions!.getById(SESSION);
    assert.deepEqual(row?.modelSelection, { temperature: 0.7 });
  });

  it("emits a warning banner when the switch reduces the context window cap", async () => {
    const ctx = makeCtx();
    incrementTokenUsage(db, SESSION, {
      inputTokens: 50_000,
      outputTokens: 100,
      contextFillTokens: 50_000,
    });
    const notices: string[] = [];
    registerActiveTurnSurface(SESSION, {
      captureAnchor: () => ({ committedProseSegments: 0, toolCalls: 0 }),
      onNotice: (notice) => notices.push(notice),
    });
    const res = (await handleIntegrationControlOp(
      makeReq({ session_id: SESSION, model_selection: { model: "provMid/mid" } }),
      operatorPrincipal(),
      ctx,
    )) as { ok: boolean };
    assert.equal(res.ok, true, "smaller-but-sufficient window must be accepted");
    const warning = notices.find((n) => /cap reduced/i.test(n));
    assert.ok(warning, `expected a reduced-window warning in ${JSON.stringify(notices)}`);
    assert.match(warning!, /Context window cap reduced/i);
    assert.match(warning!, /200,000/);
    assert.match(warning!, /128,000/);
  });
});
