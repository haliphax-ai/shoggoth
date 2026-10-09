/**
 * Bare agent id acceptance at the control-op layer: `payload.session_id` may be a full
 * session URN or a bare agent id, which resolves to that agent's bootstrap primary
 * session URN via configured platform bindings. Junk tokens and agents without platform
 * bindings must be rejected with ERR_INVALID_PAYLOAD.
 */
import { parseResponseLine, WIRE_VERSION } from "@shoggoth/authn";
import assert from "node:assert";
import Database from "better-sqlite3";
import { createConnection } from "node:net";
import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createPendingActionsStore } from "../../src/hitl/pending-actions-store";
import { createLogger } from "../../src/logging";
import { HealthRegistry } from "../../src/health";
import { ShutdownCoordinator } from "../../src/shutdown";
import { startControlPlane } from "../../src/control/control-plane";
import { resolveSessionTargetFromCliArg } from "../../src/control/resolve-session-cli-target";
import { defaultConfig, type ShoggothConfig } from "@shoggoth/shared";
import { discordPlatformRegistration } from "@shoggoth/platform-discord";
import { registerPlatform, getPlatformRegistration } from "@shoggoth/messaging";

if (!getPlatformRegistration("discord")) {
  registerPlatform(discordPlatformRegistration);
}

let prevOperatorToken: string | undefined;
let prevPrimaryChannelId: string | undefined;
let prevDiscordRoutes: string | undefined;
beforeAll(() => {
  prevOperatorToken = process.env.SHOGGOTH_OPERATOR_TOKEN;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-op-token";
  // Pin resolution env so bare-id -> primary URN is deterministic.
  prevPrimaryChannelId = process.env.SHOGGOTH_PRIMARY_CHANNEL_ID;
  prevDiscordRoutes = process.env.SHOGGOTH_DISCORD_ROUTES;
  delete process.env.SHOGGOTH_PRIMARY_CHANNEL_ID;
  delete process.env.SHOGGOTH_DISCORD_ROUTES;
});
afterAll(() => {
  if (prevOperatorToken === undefined) delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  else process.env.SHOGGOTH_OPERATOR_TOKEN = prevOperatorToken;
  if (prevPrimaryChannelId === undefined) delete process.env.SHOGGOTH_PRIMARY_CHANNEL_ID;
  else process.env.SHOGGOTH_PRIMARY_CHANNEL_ID = prevPrimaryChannelId;
  if (prevDiscordRoutes === undefined) delete process.env.SHOGGOTH_DISCORD_ROUTES;
  else process.env.SHOGGOTH_DISCORD_ROUTES = prevDiscordRoutes;
});

const TEST_OPERATOR_TOKEN = "test-op-token";

/** Bootstrap primary session URN that the bare agent id "main" resolves to. */
function expectedMainUrn(): string {
  return resolveSessionTargetFromCliArg("main", bareIdConfig("/tmp/bare-id-cfg/c.sock"));
}

function bareIdConfig(socketPath: string): ShoggothConfig {
  const base = defaultConfig(join(socketPath, "..", "cfg"));
  return {
    ...base,
    stateDbPath: join(socketPath, "..", "state.db"),
    socketPath,
    workspacesRoot: join(socketPath, "..", "workspaces"),
    agents: {
      ...base.agents,
      list: {
        main: { platforms: { discord: { routes: [] } } },
      },
    },
  };
}

async function withControlPlaneSession(
  options: { config?: ShoggothConfig; hitlPending?: boolean; sessionId?: string },
  fn: (send: (body: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-bare-id-"));
  const sock = join(dir, "c.sock");
  const config = options.config ?? bareIdConfig(sock);
  const socketPath = config.socketPath;

  const db = new Database(":memory:");
  migrate(db, defaultMigrationsDir());
  const sessions = createSessionStore(db);
  const hitlPending = options.hitlPending ? createPendingActionsStore(db) : undefined;
  if (options.sessionId) {
    sessions.create({ id: options.sessionId, workspacePath: "/w", status: "active" });
  }

  const logger = createLogger({ component: "test", minLevel: "error" });
  const health = new HealthRegistry();
  const shutdown = new ShutdownCoordinator({
    logger: logger.child({ subsystem: "shutdown" }),
    drainTimeoutMs: 5000,
  });

  const { close } = await startControlPlane({
    config,
    logger,
    shutdown,
    getHealth: () => health.snapshot(),
    version: "test-0",
    registerShutdownDrain: false,
    stateDb: db,
    hitlPending,
  });

  const send = (body: Record<string, unknown>) =>
    new Promise<string>((resolve, reject) => {
      const c = createConnection(socketPath);
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString("utf8");
        const i = buf.indexOf("\n");
        if (i >= 0) {
          resolve(buf.slice(0, i));
          c.end();
        }
      });
      c.on("error", reject);
      c.on("connect", () => {
        c.write(`${JSON.stringify(body)}\n`);
      });
    });

  try {
    await fn(send);
  } finally {
    await close();
    db.close();
  }
}

function operatorOp(id: string, op: string, payload: Record<string, unknown>) {
  return {
    v: WIRE_VERSION,
    id,
    op,
    auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
    payload,
  };
}

describe("bare agent id resolution in control ops", () => {
  it("session_model with bare agent id resolves to bootstrap primary session URN", async () => {
    if (process.platform !== "linux") return;
    const expectedUrn = expectedMainUrn();
    assert.match(expectedUrn, /^agent:main:discord:channel:/);
    // Seed the bootstrap primary session row that the bare id resolves to.
    await withControlPlaneSession({ sessionId: expectedUrn }, async (send) => {
      const line = await send(operatorOp("sm-bare-main", "session_model", { session_id: "main" }));
      const res = parseResponseLine(line);
      // The op resolves the bare id and echoes the resolved URN in the response.
      assert.equal(res.ok, true, `expected ok but got: ${JSON.stringify(res.error)}`);
      const result = res.result as Record<string, unknown> | undefined;
      assert.equal(result?.session_id, expectedUrn);

      // Companion: the same op with the full URN also succeeds.
      const line2 = await send(
        operatorOp("sm-full-urn", "session_model", { session_id: expectedUrn }),
      );
      const res2 = parseResponseLine(line2);
      assert.equal(res2.ok, true, JSON.stringify(res2.error));
    });
  });

  it("hitl_clear accepts bare agent_id and session_id", async () => {
    if (process.platform !== "linux") return;
    await withControlPlaneSession(
      { hitlPending: true, sessionId: expectedMainUrn() },
      async (send) => {
        const line = await send(
          operatorOp("hc-bare", "hitl_clear", { agent_id: "main", session_id: "main" }),
        );
        const res = parseResponseLine(line);
        assert.equal(res.ok, true, JSON.stringify(res.error));
        const result = res.result as Record<string, unknown> | undefined;
        assert.ok(Array.isArray(result?.session_ids), "session_ids should be an array");
        assert.deepEqual(result!.session_ids, [expectedMainUrn()]);
      },
    );
  });

  it("hitl_pending_list with bare agent id succeeds", async () => {
    if (process.platform !== "linux") return;
    await withControlPlaneSession(
      { hitlPending: true, sessionId: expectedMainUrn() },
      async (send) => {
        const line = await send(
          operatorOp("hpl-bare", "hitl_pending_list", { session_id: "main" }),
        );
        const res = parseResponseLine(line);
        assert.equal(res.ok, true, JSON.stringify(res.error));
        const result = res.result as Record<string, unknown> | undefined;
        assert.ok(Array.isArray(result?.pending), "pending should be an array");
      },
    );
  });

  it("rejects junk session_id token with ERR_INVALID_PAYLOAD", async () => {
    if (process.platform !== "linux") return;
    await withControlPlaneSession({ hitlPending: true }, async (send) => {
      const line = await send(operatorOp("junk-id", "hitl_pending_list", { session_id: "bad:id" }));
      const res = parseResponseLine(line);
      assert.equal(res.ok, false, "junk session_id should be rejected");
      assert.equal(res.error?.code, "ERR_INVALID_PAYLOAD");
    });
  });

  it("rejects unknown agent id with no platform bindings", async () => {
    if (process.platform !== "linux") return;
    await withControlPlaneSession({ hitlPending: true }, async (send) => {
      const line = await send(
        operatorOp("unknown-agent", "hitl_pending_list", { session_id: "no-such-agent" }),
      );
      const res = parseResponseLine(line);
      assert.equal(res.ok, false, "unknown agent id should be rejected");
      assert.equal(res.error?.code, "ERR_INVALID_PAYLOAD");
      assert.match(res.error?.message ?? "", /no platform bindings/);
    });
  });
});
