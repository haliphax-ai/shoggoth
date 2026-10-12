/**
 * session_queue_manage control op: queue indexes are 1-based on the wire.
 *
 * `list` numbers entries from 1 (Discord markdown always renders numbered
 * lists starting at 1, so 0-based indexes desync from what the operator
 * sees), and `remove` accepts 1-based index/start/end bounds which are
 * converted to the queue's internal 0-based indexes.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WIRE_VERSION, type WireRequest, type AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_POLICY_CONFIG, type ShoggothConfig } from "@shoggoth/shared";
import { TieredTurnQueue } from "../../src/sessions/session-turn-queue";
import { setTurnQueue } from "../../src/sessions/session-turn-queue-singleton";
import {
  handleIntegrationControlOp,
  IntegrationOpError,
  type IntegrationOpsContext,
} from "../../src/control/integration-ops";

const SESSION_ID = "agent:main:discord:channel:123";

const operatorPrincipal: AuthenticatedPrincipal = {
  kind: "operator",
  operatorId: "test-op",
  source: "token",
};

function minimalConfig(tmp: string): ShoggothConfig {
  const configDir = join(tmp, "config.d");
  mkdirSync(configDir, { recursive: true });
  return {
    logLevel: "info",
    stateDbPath: join(tmp, "state.db"),
    socketPath: join(tmp, "c.sock"),
    workspacesRoot: tmp,
    secretsDirectory: tmp,
    inboundMediaRoot: tmp,
    configDirectory: configDir,
    operatorDirectory: tmp,
    policy: DEFAULT_POLICY_CONFIG,
  } as ShoggothConfig;
}

function makeCtx(config: ShoggothConfig): IntegrationOpsContext {
  return {
    config,
    stateDb: undefined,
    acpxStore: undefined,
    sessions: undefined,
    sessionManager: undefined,
    acpxSupervisor: undefined,
    recordIntegrationAudit: () => {},
  };
}

function makeWireRequest(op: string, payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: randomUUID(),
    op,
    auth: { kind: "operator", token: "t" },
    payload,
  };
}

async function listLabels(ctx: IntegrationOpsContext): Promise<string[]> {
  const result = (await handleIntegrationControlOp(
    makeWireRequest("session_queue_manage", { session_id: SESSION_ID, action: "list" }),
    operatorPrincipal,
    ctx,
  )) as { entries: Array<{ label: string }> };
  return result.entries.map((e) => e.label);
}

describe("session_queue_manage control op (1-based indexes)", () => {
  let tmp: string;
  let ctx: IntegrationOpsContext;
  let queue: TieredTurnQueue;
  let releaseBlocker: () => void;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-queue-op-"));
    ctx = makeCtx(minimalConfig(tmp));
    queue = new TieredTurnQueue(2, 6);
    setTurnQueue(queue);

    // Block the session's pump so subsequent enqueues stay queued: the first
    // turn starts immediately and holds the queue until the gate resolves.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    releaseBlocker = release;
    queue
      .enqueue(SESSION_ID, "user", "blocker", async () => {
        await gate;
      })
      .catch(() => {});
    for (const label of ["u1", "u2", "u3"]) {
      queue.enqueue(SESSION_ID, "user", label, async () => {}).catch(() => {});
    }
  });

  afterEach(() => {
    releaseBlocker();
  });

  it("list returns 1-based indexes", async () => {
    const result = (await handleIntegrationControlOp(
      makeWireRequest("session_queue_manage", { session_id: SESSION_ID, action: "list" }),
      operatorPrincipal,
      ctx,
    )) as { entries: Array<{ index: number; label: string }> };

    assert.deepStrictEqual(
      result.entries.map((e) => e.index),
      [1, 2, 3],
    );
    assert.deepStrictEqual(
      result.entries.map((e) => e.label),
      ["u1", "u2", "u3"],
    );
  });

  it("remove by index treats the index as 1-based", async () => {
    const result = (await handleIntegrationControlOp(
      makeWireRequest("session_queue_manage", {
        session_id: SESSION_ID,
        action: "remove",
        by: "index",
        index: 1,
      }),
      operatorPrincipal,
      ctx,
    )) as { removed: number };

    assert.strictEqual(result.removed, 1);
    assert.deepStrictEqual(await listLabels(ctx), ["u2", "u3"]);
  });

  it("rejects index 0 with a 1-based hint", async () => {
    await assert.rejects(
      handleIntegrationControlOp(
        makeWireRequest("session_queue_manage", {
          session_id: SESSION_ID,
          action: "remove",
          by: "index",
          index: 0,
        }),
        operatorPrincipal,
        ctx,
      ),
      (err: unknown) => err instanceof IntegrationOpError && /1-based/.test(err.message),
    );
    assert.deepStrictEqual(await listLabels(ctx), ["u1", "u2", "u3"]);
  });

  it("remove by range treats start/end as 1-based inclusive bounds", async () => {
    const result = (await handleIntegrationControlOp(
      makeWireRequest("session_queue_manage", {
        session_id: SESSION_ID,
        action: "remove",
        by: "range",
        start: 2,
        end: 3,
      }),
      operatorPrincipal,
      ctx,
    )) as { removed: number };

    assert.strictEqual(result.removed, 2);
    assert.deepStrictEqual(await listLabels(ctx), ["u1"]);
  });

  it("rejects a range starting below 1", async () => {
    await assert.rejects(
      handleIntegrationControlOp(
        makeWireRequest("session_queue_manage", {
          session_id: SESSION_ID,
          action: "remove",
          by: "range",
          start: 0,
          end: 2,
        }),
        operatorPrincipal,
        ctx,
      ),
      (err: unknown) => err instanceof IntegrationOpError && /1-based/.test(err.message),
    );
    assert.deepStrictEqual(await listLabels(ctx), ["u1", "u2", "u3"]);
  });
});
