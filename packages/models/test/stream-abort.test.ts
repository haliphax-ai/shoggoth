import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import { readStreamChunkOrAbort } from "../src/stream-abort";
import { ModelRequestAbortedError } from "../src/errors";
import { isFailoverEligibleError } from "../src/classify";
import { createOpenAICompatibleProvider } from "../src/openai-compatible";
import { consumeAnthropicMessagesStream } from "../src/anthropic-messages";
import { consumeGeminiStream } from "../src/gemini";
import { setResilienceGate, ModelResilienceGate } from "../src/resilience";

// Disable retries so abort/error tests don't wait on real backoff delays
beforeEach(() => {
  setResilienceGate(new ModelResilienceGate({ maxRetries: 0 }));
});

const encoder = new TextEncoder();

/**
 * An SSE body that emits one chunk and then hangs forever (never closes),
 * simulating a long in-flight model generation. `cancel()` is observable so
 * tests can assert the response stream was actually closed.
 */
function hangingSseStream(firstChunk: string, onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      // Deliberately never closed.
    },
    cancel() {
      onCancel();
    },
  });
}

function hangingStream(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      /* emits nothing, never closes */
    },
    cancel() {
      onCancel();
    },
  });
}

describe("readStreamChunkOrAbort", () => {
  it("passes reads through when no signal is provided", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x"));
        controller.close();
      },
    });
    const reader = stream.getReader();
    const { done, value } = await readStreamChunkOrAbort(reader, undefined);
    assert.equal(done, false);
    assert.equal(new TextDecoder().decode(value), "x");
  });

  it("cancels the reader and throws ModelRequestAbortedError on mid-read abort", async () => {
    let cancelled = false;
    const reader = hangingStream(() => {
      cancelled = true;
    }).getReader();
    const ac = new AbortController();
    const pending = readStreamChunkOrAbort(reader, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(
      () => pending,
      (e: unknown) => e instanceof ModelRequestAbortedError,
    );
    assert.equal(cancelled, true, "reader.cancel() should close the response stream");
  });

  it("cancels and throws before the first read when the signal is already aborted", async () => {
    let cancelled = false;
    const reader = hangingStream(() => {
      cancelled = true;
    }).getReader();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => readStreamChunkOrAbort(reader, ac.signal),
      (e: unknown) => e instanceof ModelRequestAbortedError,
    );
    assert.equal(cancelled, true);
  });
});

describe("abort is not failover-eligible", () => {
  it("ModelRequestAbortedError must not hop to the next provider", () => {
    assert.equal(isFailoverEligibleError(new ModelRequestAbortedError()), false);
  });
});

describe("OpenAI-compatible streaming abort", () => {
  it("complete(stream) closes the SSE stream and throws when aborted mid-stream", async () => {
    let cancelled = false;
    let seenSignal: AbortSignal | undefined | null;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenSignal = init?.signal;
      return new Response(
        hangingSseStream('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', () => {
          cancelled = true;
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const p = createOpenAICompatibleProvider({
      id: "p1",
      baseUrl: "https://api.example/v1",
      fetchImpl,
    });

    const ac = new AbortController();
    const promise = p.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      signal: ac.signal,
      onTextDelta: () => {
        // Abort as soon as the first delta proves the stream is live.
        ac.abort();
      },
    });

    await assert.rejects(
      () => promise,
      (e: unknown) => e instanceof ModelRequestAbortedError,
    );
    assert.equal(cancelled, true, "SSE response stream should be closed, not drained");
    assert.equal(seenSignal, ac.signal, "the caller's signal must be forwarded to fetch");
  });

  it("forwards the abort signal through completeWithTools", async () => {
    let seenSignal: AbortSignal | undefined | null;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenSignal = init?.signal;
      return new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const p = createOpenAICompatibleProvider({
      id: "p1",
      baseUrl: "https://api.example/v1",
      fetchImpl,
    });

    const ac = new AbortController();
    await p.completeWithTools({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", parameters: {} } }],
      stream: true,
      signal: ac.signal,
    });
    assert.equal(seenSignal, ac.signal);
  });
});

describe("Anthropic streaming abort", () => {
  it("consumeAnthropicMessagesStream cancels the stream on abort", async () => {
    let cancelled = false;
    const stream = hangingSseStream(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      () => {
        cancelled = true;
      },
    );
    const ac = new AbortController();
    const promise = consumeAnthropicMessagesStream(stream, {
      accumulateTools: false,
      signal: ac.signal,
    });
    // Let the loop process the first frame, then abort while it waits for more.
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(
      () => promise,
      (e: unknown) => e instanceof ModelRequestAbortedError,
    );
    assert.equal(cancelled, true);
  });
});

describe("Gemini streaming abort", () => {
  it("consumeGeminiStream closes the stream and throws on abort", async () => {
    let cancelled = false;
    const stream = hangingSseStream(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"}}]}\n\n',
      () => {
        cancelled = true;
      },
    );
    const ac = new AbortController();
    const promise = consumeGeminiStream(stream, {
      accumulateTools: false,
      signal: ac.signal,
      onTextDelta: () => {
        ac.abort();
      },
    });
    await assert.rejects(
      () => promise,
      (e: unknown) => e instanceof ModelRequestAbortedError,
    );
    assert.equal(cancelled, true);
  });
});
