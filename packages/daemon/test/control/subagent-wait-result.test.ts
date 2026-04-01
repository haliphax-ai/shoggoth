/**
 * Tests for subagent_wait and subagent_result control ops.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { WIRE_VERSION, type WireRequest } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import {
  handleIntegrationControlOp,
  type IntegrationOpsContext,
} from "../../src/control/integration-ops";
import { createSessionManager } from "../../src/sessions/session-manager";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";

function minimalConfig(tmp: string) {
  return {
    logLevel: "info" as const,
    stateDbPath: join(tmp, "state.db"),
    socketPath: join(tmp, "c.sock"),
    workspacesRoot: tmp,
    secretsDirectory: tmp,
    inboundMediaRoot: tmp,
    configDirectory: tmp,
    hitl: {
      defaultApprovalTimeoutMs: 300_000,
      toolRisk: { read: "safe" as const, write: "caution" as const, exec: "critical" as const },
      bypassUpTo: "safe",
    },
    memory: { paths: [] as string[], embeddings: { enabled: false } },
    skills: { scanRoots: [] as string[], disabledIds: [] as string[] },
    plugins: [] as never[],
    mcp: { servers: [] as never[], poolScope: "global" as const },
    policy: DEFAULT_POLICY_CONFIG,
  };
}

function makeWireRequest(op: string, payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: randomUUID(),
    op,
    auth: { kind: "operator", token: "test" },
    payload,
  };
}

const operatorPrincipal: AuthenticatedPrincipal = {
  kind: "operator",
  operatorId: "test-operator",
  source: "token",
};

describe("subagent_wait and subagent_result control ops", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;
  let ctx: IntegrationOpsContext;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-subagent-ops-"));
    const dbPath = join(tmp, "state.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());

    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const sessionManager = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot: tmp,
    });

    ctx = {
      config: minimalConfig(tmp) as IntegrationOpsContext["config"],
      stateDb: db,
      acpxStore: undefined,
      sessions,
      sessionManager,
      acpxSupervisor: undefined,
      recordIntegrationAudit: () => {},
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // --- subagent_result tests ---

  it("subagent_result returns result for a terminated session", async () => {
    const sessions = createSessionStore(db);
    const transcript = createTranscriptStore(db);

    // Create a parent session and a child session.
    sessions.create({ id: "agent:test:discord:channel:parent-1", workspacePath: tmp });
    sessions.create({ id: "agent:test:discord:channel:child-1", workspacePath: tmp });
    const child = sessions.getById("agent:test:discord:channel:child-1")!;

    // Add transcript with a final assistant message.
    transcript.append({
      sessionId: "agent:test:discord:channel:child-1",
      contextSegmentId: child.contextSegmentId,
      role: "user",
      content: "do something",
    });
    transcript.append({
      sessionId: "agent:test:discord:channel:child-1",
      contextSegmentId: child.contextSegmentId,
      role: "assistant",
      content: "Here is the result of my work.",
    });

    // Terminate the child session.
    sessions.update("agent:test:discord:channel:child-1", { status: "terminated" });

    const req = makeWireRequest("subagent_result", {
      session_id: "agent:test:discord:channel:child-1",
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      sessionId: string;
      status: string;
      result: string;
      truncated: boolean;
    };

    assert.equal(result.sessionId, "agent:test:discord:channel:child-1");
    assert.equal(result.status, "done");
    assert.equal(result.result, "Here is the result of my work.");
    assert.equal(result.truncated, false);
  });

  it("subagent_result returns running status for active session", async () => {
    const sessions = createSessionStore(db);
    sessions.create({ id: "agent:test:discord:channel:running-1", workspacePath: tmp });

    const req = makeWireRequest("subagent_result", {
      session_id: "agent:test:discord:channel:running-1",
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      sessionId: string;
      status: string;
      result: string | null;
    };

    assert.equal(result.sessionId, "agent:test:discord:channel:running-1");
    assert.equal(result.status, "running");
    assert.equal(result.result, null);
  });

  it("subagent_result returns not_found for missing session", async () => {
    const req = makeWireRequest("subagent_result", {
      session_id: "agent:test:discord:channel:nonexistent",
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      sessionId: string;
      status: string;
      result: string | null;
    };

    assert.equal(result.status, "not_found");
    assert.equal(result.result, null);
  });

  it("subagent_result truncates output when exceeding max_chars", async () => {
    const sessions = createSessionStore(db);
    const transcript = createTranscriptStore(db);

    sessions.create({ id: "agent:test:discord:channel:trunc-1", workspacePath: tmp });
    const child = sessions.getById("agent:test:discord:channel:trunc-1")!;

    const longText = "A".repeat(500);
    transcript.append({
      sessionId: "agent:test:discord:channel:trunc-1",
      contextSegmentId: child.contextSegmentId,
      role: "assistant",
      content: longText,
    });
    sessions.update("agent:test:discord:channel:trunc-1", { status: "terminated" });

    const req = makeWireRequest("subagent_result", {
      session_id: "agent:test:discord:channel:trunc-1",
      max_chars: 100,
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      result: string;
      truncated: boolean;
    };

    assert.equal(result.result.length, 100);
    assert.equal(result.truncated, true);
  });

  // --- subagent_wait tests ---

  it("subagent_wait returns immediately for already-terminated sessions", async () => {
    const sessions = createSessionStore(db);

    sessions.create({ id: "agent:test:discord:channel:done-1", workspacePath: tmp });
    sessions.create({ id: "agent:test:discord:channel:done-2", workspacePath: tmp });
    sessions.update("agent:test:discord:channel:done-1", { status: "terminated" });
    sessions.update("agent:test:discord:channel:done-2", { status: "terminated" });

    const req = makeWireRequest("subagent_wait", {
      session_ids: [
        "agent:test:discord:channel:done-1",
        "agent:test:discord:channel:done-2",
      ],
      timeout_ms: 1000,
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      completed: { sessionId: string; status: string; exitReason: string }[];
      pending: { sessionId: string; status: string }[];
      timedOut: boolean;
    };

    assert.equal(result.completed.length, 2);
    assert.equal(result.pending.length, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.completed[0]!.exitReason, "natural");
  });

  it("subagent_wait returns not_found for missing sessions", async () => {
    const req = makeWireRequest("subagent_wait", {
      session_ids: ["agent:test:discord:channel:ghost-1"],
      timeout_ms: 1000,
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      completed: { sessionId: string; exitReason: string }[];
      pending: unknown[];
      timedOut: boolean;
    };

    assert.equal(result.completed.length, 1);
    assert.equal(result.completed[0]!.exitReason, "not_found");
    assert.equal(result.timedOut, false);
  });

  it("subagent_wait mode=any returns on first completion", async () => {
    const sessions = createSessionStore(db);

    sessions.create({ id: "agent:test:discord:channel:any-done", workspacePath: tmp });
    sessions.create({ id: "agent:test:discord:channel:any-running", workspacePath: tmp });
    sessions.update("agent:test:discord:channel:any-done", { status: "terminated" });

    const req = makeWireRequest("subagent_wait", {
      session_ids: [
        "agent:test:discord:channel:any-done",
        "agent:test:discord:channel:any-running",
      ],
      mode: "any",
      timeout_ms: 1000,
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      completed: { sessionId: string }[];
      pending: { sessionId: string }[];
      timedOut: boolean;
    };

    assert.equal(result.completed.length, 1);
    assert.equal(result.completed[0]!.sessionId, "agent:test:discord:channel:any-done");
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0]!.sessionId, "agent:test:discord:channel:any-running");
    assert.equal(result.timedOut, false);
  });

  it("subagent_wait times out for running sessions", async () => {
    const sessions = createSessionStore(db);
    sessions.create({ id: "agent:test:discord:channel:slow-1", workspacePath: tmp });

    const req = makeWireRequest("subagent_wait", {
      session_ids: ["agent:test:discord:channel:slow-1"],
      timeout_ms: 600, // very short timeout — just over one poll interval
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      completed: unknown[];
      pending: { sessionId: string }[];
      timedOut: boolean;
    };

    assert.equal(result.completed.length, 0);
    assert.equal(result.pending.length, 1);
    assert.equal(result.timedOut, true);
  });

  it("subagent_wait with include_results embeds output in completed entries", async () => {
    const sessions = createSessionStore(db);
    const transcript = createTranscriptStore(db);

    sessions.create({ id: "agent:test:discord:channel:res-1", workspacePath: tmp });
    const child = sessions.getById("agent:test:discord:channel:res-1")!;

    transcript.append({
      sessionId: "agent:test:discord:channel:res-1",
      contextSegmentId: child.contextSegmentId,
      role: "assistant",
      content: "Found 3 matching files.",
    });
    sessions.update("agent:test:discord:channel:res-1", { status: "terminated" });

    const req = makeWireRequest("subagent_wait", {
      session_ids: ["agent:test:discord:channel:res-1"],
      include_results: true,
      timeout_ms: 1000,
    });
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      completed: { sessionId: string; result?: string; truncated?: boolean }[];
      timedOut: boolean;
    };

    assert.equal(result.completed.length, 1);
    assert.equal(result.completed[0]!.result, "Found 3 matching files.");
    assert.equal(result.completed[0]!.truncated, false);
    assert.equal(result.timedOut, false);
  });

  it("subagent_wait polls and detects completion during wait", async () => {
    const sessions = createSessionStore(db);

    sessions.create({ id: "agent:test:discord:channel:delayed-1", workspacePath: tmp });

    // Terminate the session after a short delay (during the poll loop).
    setTimeout(() => {
      sessions.update("agent:test:discord:channel:delayed-1", { status: "terminated" });
    }, 300);

    const req = makeWireRequest("subagent_wait", {
      session_ids: ["agent:test:discord:channel:delayed-1"],
      timeout_ms: 5000,
    });
    const start = Date.now();
    const result = (await handleIntegrationControlOp(req, operatorPrincipal, ctx)) as {
      completed: { sessionId: string }[];
      pending: unknown[];
      timedOut: boolean;
    };
    const elapsed = Date.now() - start;

    assert.equal(result.completed.length, 1);
    assert.equal(result.pending.length, 0);
    assert.equal(result.timedOut, false);
    // Should have completed well before the 5s timeout.
    assert.ok(elapsed < 3000, `expected < 3000ms, got ${elapsed}ms`);
  });

  it("subagent_wait rejects empty session_ids", async () => {
    const req = makeWireRequest("subagent_wait", {
      session_ids: [],
    });
    await assert.rejects(
      () => handleIntegrationControlOp(req, operatorPrincipal, ctx),
      (err: Error) => err.message.includes("non-empty array"),
    );
  });

  it("subagent_result rejects missing session_id", async () => {
    const req = makeWireRequest("subagent_result", {});
    await assert.rejects(
      () => handleIntegrationControlOp(req, operatorPrincipal, ctx),
      (err: Error) => err.message.includes("non-empty string"),
    );
  });
});
