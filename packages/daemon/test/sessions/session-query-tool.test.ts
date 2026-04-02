import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DEFAULT_HITL_CONFIG, defaultConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { executeSessionAgentTurn } from "../../src/sessions/session-agent-turn";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";

/**
 * Helper: run a single agent turn where the model calls `session.query` with the given args,
 * then returns the tool result as assistant text so we can inspect it.
 */
function makeToolCallClient(toolArgs: Record<string, unknown>) {
  let callCount = 0;
  return () => ({
    async completeWithTools() {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{ id: "tc1", name: "builtin-session-query", arguments: JSON.stringify(toolArgs) }],
          usedModel: "stub",
          usedProviderId: "stub",
          degraded: false,
        };
      }
      return {
        content: "DONE",
        toolCalls: [],
        usedModel: "stub",
        usedProviderId: "stub",
        degraded: false,
      };
    },
  });
}

describe("session.query tool handler", { concurrency: false }, () => {
  let db: InstanceType<typeof Database>;
  let tmp: string;
  const sessionId = "agent:alice:discord:00000000-0000-0000-0000-000000000001";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-sq-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: sessionId, workspacePath: tmp });
    // Seed some transcript messages
    const ts = createTranscriptStore(db);
    const seg = createSessionStore(db).getById(sessionId)!.contextSegmentId;
    ts.append({ sessionId, contextSegmentId: seg, role: "user", content: "hello" });
    ts.append({ sessionId, contextSegmentId: seg, role: "assistant", content: "hi there" });
    ts.append({ sessionId, contextSegmentId: seg, role: "user", content: "how are you" });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function runWithToolArgs(
    toolArgs: Record<string, unknown>,
    configOverrides?: Partial<ReturnType<typeof defaultConfig>>,
  ) {
    const config = { ...defaultConfig(tmp), ...configOverrides };
    const sessions = createSessionStore(db);
    const session = sessions.getById(sessionId)!;
    const transcript = createTranscriptStore(db);
    const toolRuns = createToolRunStore(db);
    const hitlStack = createHitlPendingResolutionStack(db);
    const builtin = buildBuiltinOnlySessionMcpToolContext();

    // Capture the tool result from the first tool call
    let capturedToolResult: string | undefined;
    const origLoopImpl = runToolLoop;

    const result = await executeSessionAgentTurn({
      db,
      sessionId,
      session,
      transcript,
      toolRuns,
      userContent: "query test",
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
      loopImpl: origLoopImpl,
      createToolCallingClient: makeToolCallClient(toolArgs),
      resolveMcpContext: async () => builtin,
    });

    // Extract the tool result from transcript — it's the tool-role message after the assistant tool call
    const allRows = db
      .prepare(
        `SELECT seq, role, content, tool_call_id FROM transcript_messages WHERE session_id = @sid ORDER BY seq ASC`,
      )
      .all({ sid: sessionId }) as { seq: number; role: string; content: string | null; tool_call_id: string | null }[];

    const toolResultRow = allRows.find((r) => r.role === "tool" && r.tool_call_id === "tc1");
    return { result, toolResult: toolResultRow?.content ? JSON.parse(toolResultRow.content) : null };
  }

  it("returns own session messages with default args", async () => {
    const { toolResult } = await runWithToolArgs({});
    assert.ok(toolResult);
    assert.ok(Array.isArray(toolResult.messages));
    // Should have at least the 3 seeded messages plus the "query test" user message
    assert.ok(toolResult.messages.length >= 3);
    assert.equal(toolResult.messages[0].role, "user");
    assert.equal(toolResult.messages[0].content, "hello");
  });

  it("rejects unauthorized agent_id query", async () => {
    const { toolResult } = await runWithToolArgs({ agent_id: "bob" });
    assert.ok(toolResult);
    assert.ok(toolResult.error);
    assert.ok(toolResult.error.includes("not allowed"));
  });

  it("allows querying another agent when configured globally", async () => {
    const bobSessionId = "agent:bob:discord:00000000-0000-0000-0000-000000000002";
    createSessionStore(db).create({ id: bobSessionId, workspacePath: tmp });
    const bobSeg = createSessionStore(db).getById(bobSessionId)!.contextSegmentId;
    createTranscriptStore(db).append({
      sessionId: bobSessionId,
      contextSegmentId: bobSeg,
      role: "user",
      content: "bob message",
    });

    const { toolResult } = await runWithToolArgs(
      { agent_id: "bob" },
      { sessionQuery: { allowedAgentIds: ["bob"] } },
    );
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.ok(toolResult.messages.some((m: { content: string }) => m.content === "bob message"));
  });

  it("respects limit parameter", async () => {
    const { toolResult } = await runWithToolArgs({ limit: 2 });
    assert.ok(toolResult);
    assert.equal(toolResult.messages.length, 2);
  });

  it("respects offset parameter for pagination", async () => {
    // Seed messages have seq 1, 2, 3. Offset=2 should skip the first two.
    const { toolResult } = await runWithToolArgs({ offset: 2, limit: 1 });
    assert.ok(toolResult);
    assert.equal(toolResult.messages.length, 1);
    assert.equal(toolResult.messages[0].content, "how are you");
  });

  // -----------------------------------------------------------------------
  // Role filter tests
  // -----------------------------------------------------------------------

  it("filters by single role string", async () => {
    const { toolResult } = await runWithToolArgs({ role: "user" });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    // Seeded: 2 user messages + 1 "query test" user message from the turn itself
    assert.ok(toolResult.messages.length >= 2);
    for (const m of toolResult.messages) {
      assert.equal(m.role, "user");
    }
  });

  it("filters by role array", async () => {
    const { toolResult } = await runWithToolArgs({ role: ["assistant"] });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.ok(toolResult.messages.length >= 1);
    for (const m of toolResult.messages) {
      assert.equal(m.role, "assistant");
    }
  });

  it("treats empty role array as no filter (returns all roles)", async () => {
    const { toolResult } = await runWithToolArgs({ role: [] });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    const roles = new Set(toolResult.messages.map((m: { role: string }) => m.role));
    // Should have at least user and assistant from seeded data
    assert.ok(roles.has("user"));
    assert.ok(roles.has("assistant"));
  });

  it("filters by multiple roles", async () => {
    const { toolResult } = await runWithToolArgs({ role: ["user", "assistant"] });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    for (const m of toolResult.messages) {
      assert.ok(m.role === "user" || m.role === "assistant", `unexpected role: ${m.role}`);
    }
  });

  // -----------------------------------------------------------------------
  // Substring search (query) tests
  // -----------------------------------------------------------------------

  it("filters by query substring (case-insensitive)", async () => {
    const { toolResult } = await runWithToolArgs({ query: "hello" });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.equal(toolResult.messages.length, 1);
    assert.equal(toolResult.messages[0].content, "hello");
  });

  it("query returns no results when no match", async () => {
    const { toolResult } = await runWithToolArgs({ query: "nonexistent_xyz" });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.equal(toolResult.messages.length, 0);
  });

  it("combines role filter with query", async () => {
    // "hi there" is from assistant; searching "hi" should match it but not user messages
    const { toolResult } = await runWithToolArgs({ query: "hi", role: "assistant" });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.equal(toolResult.messages.length, 1);
    assert.equal(toolResult.messages[0].content, "hi there");
    assert.equal(toolResult.messages[0].role, "assistant");
  });

  // -----------------------------------------------------------------------
  // Regex search (queryRegex) tests
  // -----------------------------------------------------------------------

  it("filters by queryRegex", async () => {
    // Match messages containing "h.llo" (hello)
    const { toolResult } = await runWithToolArgs({ queryRegex: "h.llo" });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.ok(toolResult.messages.length >= 1);
    assert.ok(toolResult.messages.some((m: { content: string }) => m.content === "hello"));
  });

  it("rejects both query and queryRegex together", async () => {
    const { toolResult } = await runWithToolArgs({ query: "hello", queryRegex: "h.*" });
    assert.ok(toolResult);
    assert.ok(toolResult.error);
    assert.ok(toolResult.error.includes("mutually exclusive"));
  });

  it("rejects invalid queryRegex pattern", async () => {
    const { toolResult } = await runWithToolArgs({ queryRegex: "[invalid" });
    assert.ok(toolResult);
    assert.ok(toolResult.error);
    assert.ok(toolResult.error.includes("invalid queryRegex"));
  });

  it("queryRegex respects offset and limit on filtered results", async () => {
    // Regex matching "h" should match "hello", "hi there", "how are you"
    // With offset=1 (skip seq 1), limit=1, should get "hi there" (seq 2)
    const { toolResult } = await runWithToolArgs({ queryRegex: "^h", offset: 1, limit: 1 });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.equal(toolResult.messages.length, 1);
    assert.equal(toolResult.messages[0].content, "hi there");
  });

  // -----------------------------------------------------------------------
  // Metadata tests (includeMetadata / metadataOnly)
  // -----------------------------------------------------------------------

  it("includes _meta when includeMetadata is true", async () => {
    const { toolResult } = await runWithToolArgs({ includeMetadata: true, limit: 3 });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    for (const m of toolResult.messages) {
      assert.ok(m._meta, "expected _meta on message");
      assert.ok(typeof m._meta.timestamp === "string" || m._meta.timestamp === null);
      assert.ok(typeof m._meta.tokenCount === "number");
      assert.ok(m._meta.tokenCount >= 0);
      assert.ok(typeof m._meta.index === "number" || m._meta.index === null);
    }
    // First message should have index 0
    assert.equal(toolResult.messages[0]._meta.index, 0);
  });

  it("does not include _meta by default", async () => {
    const { toolResult } = await runWithToolArgs({ limit: 1 });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.equal(toolResult.messages[0]._meta, undefined);
  });

  it("metadataOnly omits content and implies includeMetadata", async () => {
    const { toolResult } = await runWithToolArgs({ metadataOnly: true, limit: 3 });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    for (const m of toolResult.messages) {
      // content should be omitted entirely
      assert.ok(!("content" in m), "content should not be present in metadataOnly mode");
      // _meta should be present
      assert.ok(m._meta, "expected _meta on message");
      assert.ok(typeof m._meta.tokenCount === "number");
    }
  });

  it("metadataOnly still respects role filter", async () => {
    const { toolResult } = await runWithToolArgs({ metadataOnly: true, role: "assistant" });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    for (const m of toolResult.messages) {
      assert.equal(m.role, "assistant");
      assert.ok(!("content" in m));
      assert.ok(m._meta);
    }
  });

  // -----------------------------------------------------------------------
  // Combined filter test
  // -----------------------------------------------------------------------

  it("combines role, query, and includeMetadata", async () => {
    const { toolResult } = await runWithToolArgs({
      role: "user",
      query: "how",
      includeMetadata: true,
    });
    assert.ok(toolResult);
    assert.ok(!toolResult.error, `unexpected error: ${toolResult?.error}`);
    assert.equal(toolResult.messages.length, 1);
    assert.equal(toolResult.messages[0].role, "user");
    assert.equal(toolResult.messages[0].content, "how are you");
    assert.ok(toolResult.messages[0]._meta);
    assert.ok(typeof toolResult.messages[0]._meta.timestamp === "string");
  });
});
