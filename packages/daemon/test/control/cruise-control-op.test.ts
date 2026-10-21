import { describe, it } from "vitest";
import assert from "node:assert";

import { handleIntegrationControlOp, IntegrationOpError } from "../../src/control/integration-ops";
import type { IntegrationOpsContext } from "../../src/control/integration-ops";
import type { WireRequest, AuthenticatedPrincipal } from "@shoggoth/authn";
import { WIRE_VERSION } from "@shoggoth/authn";
import { DEFAULT_HITL_CONFIG, DEFAULT_POLICY_CONFIG, type ShoggothConfig } from "@shoggoth/shared";
import { createCruiseControlStore } from "../../src/hitl/cruise-control";

const SESSION = "agent:test:discord:channel:00000000-0000-0000-0000-000000000001";

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
    operatorDirectory: "/tmp/operator",
    configDirectory: "/tmp/config",
    hitl: DEFAULT_HITL_CONFIG,
    memory: { paths: ["memory"], embeddings: { enabled: false } },
    skills: { scanRoots: ["skills"], disabledIds: [] },
    plugins: [],
    mcp: { servers: {}, poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
    decision: {
      providers: {
        "typesafe-main": {
          kind: "typesafe",
          apiKey: "test-api-key",
          baseUrl: "https://api.typesafe.ai",
          models: [{ name: "jev-latest" }],
        },
      },
    },
  } as ShoggothConfig;
}

function makeCtx(withCruise = true) {
  const cruiseControlStore = createCruiseControlStore();
  const ctx = {
    config: makeConfig(),
    stateDb: undefined,
    acpxStore: undefined,
    sessions: undefined,
    sessionManager: undefined,
    acpxSupervisor: undefined,
    recordIntegrationAudit: () => {},
    ...(withCruise ? { cruiseControl: cruiseControlStore } : {}),
  } as unknown as IntegrationOpsContext;
  return { ctx, cruiseControlStore };
}

function makeReq(payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: "test-1",
    op: "hitl_cruise_control",
    payload,
  };
}

describe("hitl_cruise_control control op", () => {
  it("rejects non-operator principals", async () => {
    const { ctx } = makeCtx();
    await assert.rejects(
      () =>
        handleIntegrationControlOp(
          makeReq({ session_id: SESSION }),
          { kind: "agent", sessionId: SESSION } as AuthenticatedPrincipal,
          ctx,
        ),
      (err: unknown) => err instanceof IntegrationOpError && err.code === "ERR_FORBIDDEN",
    );
  });

  it("returns ERR_CRUISE_UNAVAILABLE when the store is not wired", async () => {
    const { ctx } = makeCtx(false);
    await assert.rejects(
      () => handleIntegrationControlOp(makeReq({ session_id: SESSION }), operatorPrincipal(), ctx),
      (err: unknown) => err instanceof IntegrationOpError && err.code === "ERR_CRUISE_UNAVAILABLE",
    );
  });

  it("activates with yes/no guidance and surfaces a missing-model warning", async () => {
    const { ctx, cruiseControlStore } = makeCtx();
    const res = (await handleIntegrationControlOp(
      makeReq({ session_id: SESSION, yes: "approve routine ops", no: "deny risky ops" }),
      operatorPrincipal(),
      ctx,
    )) as { active: boolean; warnings: string[] };
    assert.equal(res.active, true);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0]!, /no cruise control model/);
    const policy = cruiseControlStore.get(SESSION);
    assert.equal(policy?.yes, "approve routine ops");
    assert.equal(policy?.no, "deny risky ops");
    assert.equal(policy?.escalate, undefined);
  });

  it("activates with escalate + model and emits no warnings", async () => {
    const { ctx, cruiseControlStore } = makeCtx();
    const res = (await handleIntegrationControlOp(
      makeReq({
        session_id: SESSION,
        yes: "y",
        no: "n",
        escalate: "e",
        model: "typesafe-main/jev-latest",
      }),
      operatorPrincipal(),
      ctx,
    )) as { active: boolean; warnings: string[] };
    assert.equal(res.active, true);
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(cruiseControlStore.get(SESSION), {
      yes: "y",
      no: "n",
      escalate: "e",
      model: "typesafe-main/jev-latest",
    });
  });

  it("answers a status query when no guidance is provided", async () => {
    const { ctx, cruiseControlStore } = makeCtx();
    cruiseControlStore.set(SESSION, { yes: "y", no: "n" });
    const res = (await handleIntegrationControlOp(
      makeReq({ session_id: SESSION }),
      operatorPrincipal(),
      ctx,
    )) as { active: boolean; policy: { yes: string } | null };
    assert.equal(res.active, true);
    assert.equal(res.policy?.yes, "y");

    const res2 = (await handleIntegrationControlOp(
      makeReq({ session_id: "agent:other:discord:channel:00000000-0000-0000-0000-000000000009" }),
      operatorPrincipal(),
      ctx,
    )) as { active: boolean; policy: unknown };
    assert.equal(res2.active, false);
    assert.equal(res2.policy, null);
  });

  it("deactivates and reports whether anything was cleared", async () => {
    const { ctx, cruiseControlStore } = makeCtx();
    cruiseControlStore.set(SESSION, { yes: "y", no: "n" });
    const res = (await handleIntegrationControlOp(
      makeReq({ session_id: SESSION, deactivate: true }),
      operatorPrincipal(),
      ctx,
    )) as { active: boolean; cleared: boolean };
    assert.equal(res.active, false);
    assert.equal(res.cleared, true);
    assert.equal(cruiseControlStore.isActive(SESSION), false);

    const res2 = (await handleIntegrationControlOp(
      makeReq({ session_id: SESSION, deactivate: true }),
      operatorPrincipal(),
      ctx,
    )) as { cleared: boolean };
    assert.equal(res2.cleared, false);
  });

  it("requires both yes and no when partially activating", async () => {
    const { ctx } = makeCtx();
    // Only `yes` provided → treated as a status query (no activation).
    const res = (await handleIntegrationControlOp(
      makeReq({ session_id: SESSION, yes: "y" }),
      operatorPrincipal(),
      ctx,
    )) as { active: boolean };
    assert.equal(res.active, false);
  });
});
