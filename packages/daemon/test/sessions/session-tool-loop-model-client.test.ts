import { describe, it } from "vitest";
import assert from "node:assert";
import { createSessionToolLoopModelClient } from "../../src/sessions/session-tool-loop-model-client";

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
