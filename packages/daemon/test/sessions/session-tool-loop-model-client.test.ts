import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createSessionToolLoopModelClient } from "../../src/sessions/session-tool-loop-model-client";

// Mock compactSessionTranscript
vi.mock("../../src/transcript-compact", () => ({
  compactSessionTranscript: vi.fn(),
}));

// Mock transcript-to-chat
vi.mock("../../src/sessions/transcript-to-chat", async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    loadSessionTranscriptAsModelChat: vi.fn(),
  };
});

// Mock @shoggoth/models for resolveCompactionPolicyFromModelsConfig and createFailoverClientFromModelsConfig
vi.mock("@shoggoth/models", async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    resolveCompactionPolicyFromModelsConfig: vi.fn(() => ({
      maxContextChars: 80_000,
      preserveRecentMessages: 2,
    })),
    createFailoverClientFromModelsConfig: vi.fn(() => ({})),
  };
});

import { compactSessionTranscript } from "../../src/transcript-compact";
import { loadSessionTranscriptAsModelChat } from "../../src/sessions/transcript-to-chat";

function stubToolClient(responses?: Array<{
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}>) {
  let callIdx = 0;
  const defaultResp = { content: "done", toolCalls: [], usedProviderId: "p", usedModel: "m", degraded: false };
  return {
    async completeWithTools(_input: { messages: unknown[] }) {
      const resp = responses?.[callIdx] ?? defaultResp;
      callIdx++;
      return { ...resp, usedProviderId: "p", usedModel: "m", degraded: false };
    },
  };
}

describe("createSessionToolLoopModelClient", () => {
  it("accumulates tool results via pushToolMessage for the next completeWithTools", async () => {
    let step = 0;
    const toolClient = {
      async completeWithTools(input: { messages: unknown[] }) {
        step += 1;
        if (step === 1) {
          assert.equal(input.messages.length, 2);
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "builtin-read", arguments: "{}" }],
            usedProviderId: "p",
            usedModel: "m",
            degraded: false,
          };
        }
        const msgs = input.messages as { role: string; toolCallId?: string }[];
        assert.ok(msgs.some((m) => m.role === "tool"));
        return {
          content: "done",
          toolCalls: [],
          usedProviderId: "p",
          usedModel: "m",
          degraded: true,
        };
      },
    };

    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "builtin-read", parameters: {} } }],
    });

    const t1 = await model.complete();
    assert.equal(t1.toolCalls.length, 1);
    model.pushToolMessage!({ toolCallId: "c1", content: '{"ok":true}' });

    const t2 = await model.complete();
    assert.equal(t2.toolCalls.length, 0);
    assert.equal(t2.content, "done");

    const banner = model.getSessionToolLoopFailoverState();
    assert.equal(banner?.degraded, true);
  });

  it("streams model text and prefixes prior round content before tool follow-up", async () => {
    const deltas: string[] = [];
    let step = 0;
    const toolClient = {
      async completeWithTools(input: unknown) {
        step += 1;
        const req = input as { stream?: boolean; onTextDelta?: (d: string, a: string) => void };
        if (step === 1) {
          assert.equal(req.stream, true);
          req.onTextDelta?.("a", "a");
          req.onTextDelta?.("b", "ab");
          return {
            content: "ab",
            toolCalls: [{ id: "c1", name: "builtin-read", arguments: "{}" }],
            usedProviderId: "p",
            usedModel: "m",
            degraded: false,
          };
        }
        assert.equal(req.stream, true);
        req.onTextDelta?.("x", "x");
        req.onTextDelta?.("y", "xy");
        return {
          content: "xy",
          toolCalls: [],
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };

    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "builtin-read", parameters: {} } }],
      streamModel: true,
      onModelTextDelta: (t) => {
        deltas.push(t);
      },
    });

    const t1 = await model.complete();
    assert.equal(t1.toolCalls.length, 1);
    model.pushToolMessage!({ toolCallId: "c1", content: "{}" });
    await model.complete();

    assert.ok(deltas.includes("ab"));
    assert.ok(deltas.some((d) => d === "abxy"));
  });
});

describe("mid-turn compaction in complete()", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-stlmc-"));
    db = new Database(join(tmp, "test.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-1", workspacePath: tmp });
    vi.mocked(compactSessionTranscript).mockReset();
    vi.mocked(loadSessionTranscriptAsModelChat).mockReset();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("triggers compaction when estimated tokens exceed budget", async () => {
    // Set up: large tool message content so token estimate exceeds budget.
    // ctxWindowTokens=100, reserveTokens=50 → budget is 50 tokens.
    // A tool message with 400 JSON chars → 400/2 = 200 tokens → exceeds 50.
    const bigToolContent = "x".repeat(400);

    vi.mocked(compactSessionTranscript).mockResolvedValue({ compacted: true, messageCount: 2 });
    vi.mocked(loadSessionTranscriptAsModelChat).mockReturnValue([
      { role: "user", content: "hi" },
      { role: "assistant", content: "short" },
    ]);

    const toolClient = stubToolClient();
    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [],
      compaction: {
        db,
        sessionId: "sess-1",
        contextSegmentId: "default",
        ctxWindowTokens: 100,
        reserveTokens: 50,
        modelsConfig: undefined as any,
        env: {},
        systemPromptChars: 0,
        toolSchemaChars: 0,
      },
    });

    // Push a large tool message to blow the budget
    model.pushToolMessage!({ toolCallId: "tc1", content: bigToolContent });

    await model.complete();

    assert.ok(vi.mocked(compactSessionTranscript).mock.calls.length > 0, "compactSessionTranscript should have been called");
    assert.ok(vi.mocked(loadSessionTranscriptAsModelChat).mock.calls.length > 0, "transcript should have been reloaded");
  });

  it("does NOT trigger compaction when within budget", async () => {
    const toolClient = stubToolClient();
    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [],
      compaction: {
        db,
        sessionId: "sess-1",
        contextSegmentId: "default",
        ctxWindowTokens: 100_000,
        reserveTokens: 1_000,
        modelsConfig: undefined as any,
        env: {},
        systemPromptChars: 12, // "sys" → 3 chars/4 ≈ 1 token
        toolSchemaChars: 0,
      },
    });

    await model.complete();

    assert.equal(vi.mocked(compactSessionTranscript).mock.calls.length, 0, "compactSessionTranscript should NOT have been called");
  });

  it("resets internal messages to compacted transcript after compaction", async () => {
    const bigToolContent = "x".repeat(400);

    vi.mocked(compactSessionTranscript).mockResolvedValue({ compacted: true, messageCount: 1 });
    vi.mocked(loadSessionTranscriptAsModelChat).mockReturnValue([
      { role: "user", content: "compacted" },
    ]);

    // Track what messages are sent to completeWithTools
    let capturedMessages: any[] = [];
    const toolClient = {
      async completeWithTools(input: { messages: unknown[] }) {
        capturedMessages = input.messages as any[];
        return { content: "ok", toolCalls: [], usedProviderId: "p", usedModel: "m", degraded: false };
      },
    };

    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [],
      compaction: {
        db,
        sessionId: "sess-1",
        contextSegmentId: "default",
        ctxWindowTokens: 100,
        reserveTokens: 50,
        modelsConfig: undefined as any,
        env: {},
        systemPromptChars: 0,
        toolSchemaChars: 0,
      },
    });

    model.pushToolMessage!({ toolCallId: "tc1", content: bigToolContent });
    await model.complete();

    // After compaction, messages should be: system + reloaded transcript
    assert.equal(capturedMessages[0]?.role, "system");
    assert.equal(capturedMessages[0]?.content, "sys");
    assert.equal(capturedMessages[1]?.role, "user");
    assert.equal(capturedMessages[1]?.content, "compacted");
    assert.equal(capturedMessages.length, 2);
  });

  it("handles compaction failure gracefully (logs warning, proceeds)", async () => {
    const bigToolContent = "x".repeat(400);

    vi.mocked(compactSessionTranscript).mockRejectedValue(new Error("model unreachable"));

    let capturedMessages: any[] = [];
    const toolClient = {
      async completeWithTools(input: { messages: unknown[] }) {
        capturedMessages = input.messages as any[];
        return { content: "ok", toolCalls: [], usedProviderId: "p", usedModel: "m", degraded: false };
      },
    };

    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [],
      compaction: {
        db,
        sessionId: "sess-1",
        contextSegmentId: "default",
        ctxWindowTokens: 100,
        reserveTokens: 50,
        modelsConfig: undefined as any,
        env: {},
        systemPromptChars: 0,
        toolSchemaChars: 0,
      },
    });

    model.pushToolMessage!({ toolCallId: "tc1", content: bigToolContent });

    // Should NOT throw
    await model.complete();

    // Compaction was attempted
    assert.ok(vi.mocked(compactSessionTranscript).mock.calls.length > 0, "compactSessionTranscript should have been called");
    // Should have proceeded with original messages (system + user + tool)
    assert.ok(capturedMessages.length > 0, "should have called completeWithTools despite compaction failure");
    assert.equal(vi.mocked(loadSessionTranscriptAsModelChat).mock.calls.length, 0, "should NOT reload transcript on failure");
  });

  it("uses split token estimation: tool messages at chars/2, text at chars/4", async () => {
    // Scenario: text-heavy messages should use chars/4, tool messages chars/2.
    // 200 chars of user text → 200/4 = 50 tokens
    // Budget: ctxWindowTokens=100, reserveTokens=40 → threshold = 60
    // 50 < 60 → no compaction
    const toolClient = stubToolClient();
    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [
        { role: "system", content: "" },
        { role: "user", content: "a".repeat(200) },
      ],
      tools: [],
      compaction: {
        db,
        sessionId: "sess-1",
        contextSegmentId: "default",
        ctxWindowTokens: 100,
        reserveTokens: 40,
        modelsConfig: undefined as any,
        env: {},
        systemPromptChars: 0,
        toolSchemaChars: 0,
      },
    });

    await model.complete();
    assert.equal(vi.mocked(compactSessionTranscript).mock.calls.length, 0, "text at chars/4 should be within budget");

    // Now same 200 chars but as a tool message → 200/2 = 100 tokens > 60 → triggers compaction
    vi.mocked(compactSessionTranscript).mockResolvedValue({ compacted: false, messageCount: 2 });

    const model2 = createSessionToolLoopModelClient({
      toolClient: stubToolClient(),
      initialMessages: [
        { role: "system", content: "" },
        { role: "user", content: "hi" },
      ],
      tools: [],
      compaction: {
        db,
        sessionId: "sess-1",
        contextSegmentId: "default",
        ctxWindowTokens: 100,
        reserveTokens: 40,
        modelsConfig: undefined as any,
        env: {},
        systemPromptChars: 0,
        toolSchemaChars: 0,
      },
    });

    // Push a tool message with 200 chars → 200/2 = 100 tokens > 60
    model2.pushToolMessage!({ toolCallId: "tc1", content: "b".repeat(200) });
    await model2.complete();
    assert.ok(vi.mocked(compactSessionTranscript).mock.calls.length > 0, "tool content at chars/2 should exceed budget");
  });
});
