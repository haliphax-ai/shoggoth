/**
 * Tests for SystemContext integration in session agent turns.
 * Verifies envelope rendering, transcript storage, and pass-through behavior.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DEFAULT_HITL_CONFIG, defaultConfig } from "@shoggoth/shared";
import { renderSystemContextEnvelope, type SystemContext } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../src/db/migrate";
import { createHitlPendingResolutionStack } from "../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../src/policy/engine";
import { executeSessionAgentTurn } from "../src/sessions/session-agent-turn";
import { buildBuiltinOnlySessionMcpToolContext } from "../src/sessions/session-mcp-tool-context";
import { createSessionStore } from "../src/sessions/session-store";
import { createTranscriptStore } from "../src/sessions/transcript-store";
import { createToolRunStore } from "../src/sessions/tool-run-store";
import { runToolLoop } from "../src/sessions/tool-loop";

describe("SystemContext in session agent turns", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;
  const SESSION_ID = "sess-sysctx";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-sysctx-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: SESSION_ID, workspacePath: tmp });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildTurnInput(overrides: {
    userContent: string;
    systemContext?: SystemContext;
  }) {
    const config = defaultConfig(tmp);
    const sessions = createSessionStore(db);
    const session = sessions.getById(SESSION_ID)!;
    const transcript = createTranscriptStore(db);
    const toolRuns = createToolRunStore(db);
    const hitlStack = createHitlPendingResolutionStack(db);
    const builtin = buildBuiltinOnlySessionMcpToolContext();

    return {
      db,
      sessionId: SESSION_ID,
      session,
      transcript,
      toolRuns,
      userContent: overrides.userContent,
      systemContext: overrides.systemContext,
      userMetadata: undefined,
      systemPrompt: "You are a test assistant.",
      env: process.env,
      config,
      policyEngine: createPolicyEngine(config.policy),
      getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
      hitl: {
        principalRoles: [] as string[],
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: hitlStack.waitForHitlResolution,
      },
      loopImpl: runToolLoop,
      createToolCallingClient: () => ({
        async completeWithTools() {
          return {
            content: "REPLY",
            toolCalls: [],
            usedModel: "stub",
            usedProviderId: "stub",
            degraded: false,
          };
        },
      }),
      resolveMcpContext: async () => builtin,
    };
  }

  it("when systemContext is provided, the user content in the transcript includes the envelope", async () => {
    const ctx: SystemContext = {
      kind: "subagent.task",
      summary: "You are a subagent. Complete the task.",
      data: { parent_session_id: "parent-1" },
    };
    await executeSessionAgentTurn(buildTurnInput({
      userContent: "Do the thing.",
      systemContext: ctx,
    }));

    // Read the user message from the transcript
    const transcript = createTranscriptStore(db);
    const page = transcript.listPage({
      sessionId: SESSION_ID,
      contextSegmentId: createSessionStore(db).getById(SESSION_ID)!.contextSegmentId,
      afterSeq: 0,
      limit: 100,
    });
    const userMsg = page.messages.find((m) => m.role === "user");
    assert.ok(userMsg, "user message should exist in transcript");

    const envelope = renderSystemContextEnvelope(ctx, createSessionStore(db).getById(SESSION_ID)!.systemContextToken);
    assert.ok(
      userMsg.content!.startsWith(envelope),
      "user content should start with the system context envelope",
    );
    assert.ok(
      userMsg.content!.includes("Do the thing."),
      "user content should include the original user content",
    );
  });

  it("when systemContext is not provided, the user content is unchanged", async () => {
    await executeSessionAgentTurn(buildTurnInput({
      userContent: "Just a normal message.",
    }));

    const transcript = createTranscriptStore(db);
    const page = transcript.listPage({
      sessionId: SESSION_ID,
      contextSegmentId: createSessionStore(db).getById(SESSION_ID)!.contextSegmentId,
      afterSeq: 0,
      limit: 100,
    });
    const userMsg = page.messages.find((m) => m.role === "user");
    assert.ok(userMsg);
    assert.equal(userMsg.content, "Just a normal message.");
  });

  it("the systemContext is stored on the transcript entry", async () => {
    const ctx: SystemContext = {
      kind: "fan_out.complete",
      summary: "Fan-out done.",
      data: { workflow_id: "wf-1" },
    };
    await executeSessionAgentTurn(buildTurnInput({
      userContent: "Check results.",
      systemContext: ctx,
    }));

    // Query the raw DB to verify system_context_json is stored
    const row = db.prepare(
      "SELECT system_context_json FROM transcript_messages WHERE session_id = ? AND role = 'user'",
    ).get(SESSION_ID) as { system_context_json: string | null };
    assert.ok(row, "transcript row should exist");
    assert.ok(row.system_context_json, "system_context_json should be stored");
    const stored = JSON.parse(row.system_context_json!);
    assert.deepEqual(stored, ctx);
  });

  it("the envelope format matches the expected divider pattern", async () => {
    const ctx: SystemContext = {
      kind: "session.steer",
      summary: "Adjust behavior.",
    };
    await executeSessionAgentTurn(buildTurnInput({
      userContent: "New instructions.",
      systemContext: ctx,
    }));

    const transcript = createTranscriptStore(db);
    const page = transcript.listPage({
      sessionId: SESSION_ID,
      contextSegmentId: createSessionStore(db).getById(SESSION_ID)!.contextSegmentId,
      afterSeq: 0,
      limit: 100,
    });
    const userMsg = page.messages.find((m) => m.role === "user");
    assert.ok(userMsg);
    assert.match(userMsg.content!, /^--- BEGIN TRUSTED SYSTEM CONTEXT(?: \[token:[0-9a-f]+\])? ---\n/);
    assert.match(userMsg.content!, /--- END TRUSTED SYSTEM CONTEXT(?: \[token:[0-9a-f]+\])? ---\n\nNew instructions\.$/);
  });
});
