import { describe, it } from "vitest";
import assert from "node:assert";
import { ModelRequestAbortedError } from "@shoggoth/models";
import { createSessionToolLoopModelClient } from "../../src/sessions/session-tool-loop-model-client";
import { TurnAbortedError } from "../../src/sessions/session-turn-abort";

describe("createSessionToolLoopModelClient — turn abort", () => {
  it("forwards the turn abort signal to completeWithTools", async () => {
    const ac = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const toolClient = {
      async completeWithTools(input: { messages: unknown[]; signal?: AbortSignal }) {
        seenSignal = input.signal;
        return {
          content: "ok",
          toolCalls: [],
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };

    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [{ role: "user", content: "hi" }],
      tools: [],
      turnAbortSignal: ac.signal,
    });

    await model.complete();
    assert.equal(seenSignal, ac.signal);
  });

  it("surfaces ModelRequestAbortedError as TurnAbortedError", async () => {
    const ac = new AbortController();
    const toolClient = {
      async completeWithTools(_input: { messages: unknown[] }) {
        // Simulate the provider layer closing the SSE stream on abort.
        ac.abort();
        throw new ModelRequestAbortedError();
      },
    };

    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [{ role: "user", content: "hi" }],
      tools: [],
      turnAbortSignal: ac.signal,
    });

    await assert.rejects(
      () => model.complete(),
      (e: unknown) => e instanceof TurnAbortedError,
    );
  });

  it("does not translate non-abort errors", async () => {
    const ac = new AbortController();
    const toolClient = {
      async completeWithTools(_input: { messages: unknown[] }) {
        throw new Error("boom");
      },
    };

    const model = createSessionToolLoopModelClient({
      toolClient,
      initialMessages: [{ role: "user", content: "hi" }],
      tools: [],
      turnAbortSignal: ac.signal,
    });

    await assert.rejects(
      () => model.complete(),
      (e: unknown) => e instanceof Error && e.message === "boom",
    );
  });
});
