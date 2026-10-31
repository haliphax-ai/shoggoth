import { describe, it, expect } from "vitest";
import assert from "node:assert";
import { createSessionToolLoopModelClient } from "../../src/sessions/session-tool-loop-model-client";
import { isTruncationFinishReason } from "@shoggoth/models";

/**
 * A tool call whose arguments were cut off mid-JSON by the provider's
 * output-token limit — the exact shape that used to poison the next request.
 */
const TRUNCATED_ARGS = '{"path":"/tmp/very-large-file.txt","content":"line one\\nline two';

function stubToolClient(
  responses: Array<{
    content: string | null;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    finishReason?: string;
  }>,
) {
  let callIdx = 0;
  /** Every request's messages, in call order — what the provider received. */
  const requests: { messages: readonly unknown[] }[] = [];
  return {
    requests,
    async completeWithTools(input: { messages: readonly unknown[] }) {
      requests.push({ messages: input.messages });
      const resp = responses[callIdx] ?? responses[responses.length - 1]!;
      callIdx++;
      return {
        ...resp,
        usedProviderId: "p",
        usedModel: "m",
        degraded: false,
      } as never;
    },
  };
}

describe("createSessionToolLoopModelClient — output-truncated tool call arguments", () => {
  it("replays parseable arguments to the provider on the next request", async () => {
    const toolClient = stubToolClient([
      {
        content: null,
        toolCalls: [{ id: "c1", name: "builtin-write", arguments: TRUNCATED_ARGS }],
        finishReason: "length",
      },
      { content: "done", toolCalls: [], finishReason: "stop" },
    ]);

    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [{ role: "user", content: "write the file" }],
      tools: [{ type: "function", function: { name: "builtin-write", parameters: {} } }],
    });

    const t1 = await model.complete();
    // The tool loop sees the RAW (truncated) arguments so it can detect the
    // truncation and fail fast.
    assert.equal(t1.toolCalls.length, 1);
    assert.equal(t1.toolCalls[0]!.argsJson, TRUNCATED_ARGS);
    assert.equal(t1.finishReason, "length");

    // The model answers the call (as the tool loop does with its error body).
    model.pushToolMessage!({ toolCallId: "c1", content: '{"error":"output_truncated"}' });

    // The next request must NOT carry the broken arguments: the provider
    // rejects the whole request with an opaque 400 when it does.
    const t2 = await model.complete();
    assert.equal(t2.toolCalls.length, 0);

    // Inspect the messages handed to the provider on the second round.
    assert.equal(toolClient.requests.length, 2);
    const captured = toolClient.requests[1]!.messages;
    const assistantMsg = captured.find(
      (m) => typeof m === "object" && m !== null && (m as { role?: string }).role === "assistant",
    ) as { toolCalls?: { arguments: string }[] } | undefined;
    assert.ok(assistantMsg?.toolCalls?.length, "expected the assistant turn to be replayed");
    const replayedArgs = assistantMsg.toolCalls![0]!.arguments;
    // Parseable — the upstream will not reject the request.
    assert.doesNotThrow(() => JSON.parse(replayedArgs));
    assert.notEqual(replayedArgs, TRUNCATED_ARGS);
  });

  it("surfaces the round's finish reason to the tool loop", async () => {
    const toolClient = stubToolClient([
      {
        content: null,
        toolCalls: [{ id: "c1", name: "builtin-write", arguments: TRUNCATED_ARGS }],
        finishReason: "max_tokens",
      },
    ]);
    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [{ role: "user", content: "write the file" }],
      tools: [{ type: "function", function: { name: "builtin-write", parameters: {} } }],
    });
    const t1 = await model.complete();
    assert.equal(t1.finishReason, "max_tokens");
    expect(isTruncationFinishReason(t1.finishReason)).toBe(true);
  });

  it("preserves valid arguments verbatim", async () => {
    const args = '{"path":"/tmp/a.txt","content":"hello"}';
    const toolClient = stubToolClient([
      {
        content: null,
        toolCalls: [{ id: "c1", name: "builtin-write", arguments: args }],
        finishReason: "tool_calls",
      },
    ]);
    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [{ role: "user", content: "write the file" }],
      tools: [{ type: "function", function: { name: "builtin-write", parameters: {} } }],
    });
    const t1 = await model.complete();
    assert.equal(t1.toolCalls[0]!.argsJson, args);
  });
});
