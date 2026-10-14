/**
 * session_kill control op: the `subagent_only` guard (set by the platform
 * `/close` command translation) refuses top-level agent sessions so a
 * messaging-surface command can never orphan an agent's main session.
 * The CLI kill path (no flag) still terminates any session.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { WIRE_VERSION, type WireRequest, type AuthenticatedPrincipal } from "@shoggoth/authn";
import { defaultConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import type { SessionManager } from "../../src/sessions/session-manager";
import { disposeSubagentRuntime } from "../../src/subagent/subagent-disposables";
import { closeTestDb } from "../helpers/close-test-db";
import {
  handleIntegrationControlOp,
  IntegrationOpError,
  type IntegrationOpsContext,
} from "../../src/control/integration-ops";

const PARENT = "agent:p:discord:channel:30000000-0000-4000-8000-000000000099";
const CHILD =
  "agent:p:discord:channel:30000000-0000-4000-8000-000000000099:cccccccc-bbbb-4ccc-dddd-eeeeeeeeeeee";

const operatorPrincipal: AuthenticatedPrincipal = {
  kind: "operator",
  operatorId: "test-op",
  source: "token",
};

function makeReq(op: string, payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: randomUUID(),
    op,
    auth: { kind: "operator", token: "t" },
    payload,
  };
}

describe("session_kill subagent_only guard", () => {
  let dir: string;
  let db: Database.Database;
  let ctx: IntegrationOpsContext;
  let killed: string[];

  beforeEach(() => {
    dir = join(tmpdir(), `shoggoth-kill-guard-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    db = new Database(join(dir, "state.db"));
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    sessions.create({ id: PARENT, workspacePath: "/w", status: "active" });
    sessions.create({ id: CHILD, workspacePath: "/w", status: "active" });
    sessions.update(CHILD, {
      parentSessionId: PARENT,
      subagentMode: "persistent",
      subagentPlatformThreadId: "thread-kill-1",
      subagentExpiresAtMs: Date.now() + 3_600_000,
    });
    killed = [];
    ctx = {
      config: defaultConfig(dir),
      stateDb: db,
      sessions,
      sessionManager: {
        kill: (sid: string) => {
          killed.push(sid);
          sessions.update(sid, { status: "terminated" });
        },
      } as unknown as SessionManager,
      recordIntegrationAudit: () => {},
    };
  });

  afterEach(async () => {
    disposeSubagentRuntime(CHILD);
    await closeTestDb(db, dir);
  });

  it("refuses a top-level agent session when subagent_only is set", async () => {
    await assert.rejects(
      handleIntegrationControlOp(
        makeReq("session_kill", { session_id: PARENT, subagent_only: true }),
        operatorPrincipal,
        ctx,
      ),
      (err: unknown) =>
        err instanceof IntegrationOpError &&
        err.code === "ERR_FORBIDDEN" &&
        /top-level/.test(err.message),
    );
    assert.deepStrictEqual(killed, [], "no kill should have happened");
    assert.equal(ctx.sessions!.getById(PARENT)!.status, "active");
  });

  it("kills a subagent session when subagent_only is set", async () => {
    const res = (await handleIntegrationControlOp(
      makeReq("session_kill", { session_id: CHILD, subagent_only: true }),
      operatorPrincipal,
      ctx,
    )) as { ok: boolean };
    assert.equal(res.ok, true);
    assert.deepStrictEqual(killed, [CHILD]);
    assert.equal(ctx.sessions!.getById(CHILD)!.status, "terminated");
  });

  it("still kills a top-level session without the flag (CLI path)", async () => {
    const res = (await handleIntegrationControlOp(
      makeReq("session_kill", { session_id: PARENT }),
      operatorPrincipal,
      ctx,
    )) as { ok: boolean };
    assert.equal(res.ok, true);
    assert.deepStrictEqual(killed, [PARENT]);
    assert.equal(ctx.sessions!.getById(PARENT)!.status, "terminated");
  });
});
