import { describe, it, expect, vi } from "vitest";
import {
  createQueuedMessageIndicator,
  QUEUED_MESSAGE_NOTICE,
  QUEUED_MESSAGE_REACTION,
  type QueuedMessageIndicatorInput,
} from "../../src/presentation/queued-message-indicator";
import type { PlatformCapabilities } from "../../src/presentation/platform-adapter";

/** Flush pending microtasks/macrotasks so fire-and-forget marks settle. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function makeLogger() {
  return { debug: vi.fn(), warn: vi.fn() };
}

function baseInput(
  overrides: Partial<QueuedMessageIndicatorInput> & { capabilities: PlatformCapabilities },
): QueuedMessageIndicatorInput {
  return {
    sessionId: "s1",
    messageId: "m1",
    logger: makeLogger(),
    ...overrides,
  };
}

describe("createQueuedMessageIndicator", () => {
  it("adds the ⏳ reaction when the platform supports reactions", async () => {
    const addReaction = vi.fn(async () => {});
    const removeReaction = vi.fn(async () => {});
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { reactions: { addReaction, removeReaction } },
        resolveChannelId: () => "c1",
      }),
    );

    indicator.markQueued();
    await settle();

    expect(addReaction).toHaveBeenCalledTimes(1);
    expect(addReaction).toHaveBeenCalledWith("c1", "m1", QUEUED_MESSAGE_REACTION);
    expect(removeReaction).not.toHaveBeenCalled();
  });

  it("removes the reaction when cleared", async () => {
    const addReaction = vi.fn(async () => {});
    const removeReaction = vi.fn(async () => {});
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { reactions: { addReaction, removeReaction } },
        resolveChannelId: () => "c1",
      }),
    );

    indicator.markQueued();
    await settle();
    await indicator.clear();

    expect(removeReaction).toHaveBeenCalledTimes(1);
    expect(removeReaction).toHaveBeenCalledWith("c1", "m1", QUEUED_MESSAGE_REACTION);
  });

  it("waits for an in-flight reaction add before removing it", async () => {
    let resolveAdd!: () => void;
    const addReaction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const removeReaction = vi.fn(async () => {});
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { reactions: { addReaction, removeReaction } },
        resolveChannelId: () => "c1",
      }),
    );

    indicator.markQueued();
    const clearing = indicator.clear();
    resolveAdd();
    await clearing;

    expect(removeReaction).toHaveBeenCalledTimes(1);
  });

  it("does not remove the reaction when the add failed", async () => {
    const addReaction = vi.fn(async () => {
      throw new Error("403");
    });
    const removeReaction = vi.fn(async () => {});
    const logger = makeLogger();
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { reactions: { addReaction, removeReaction } },
        resolveChannelId: () => "c1",
        logger,
      }),
    );

    indicator.markQueued();
    await indicator.clear();

    expect(removeReaction).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("logs a warning and resolves when reaction removal fails", async () => {
    const addReaction = vi.fn(async () => {});
    const removeReaction = vi.fn(async () => {
      throw new Error("403");
    });
    const logger = makeLogger();
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { reactions: { addReaction, removeReaction } },
        resolveChannelId: () => "c1",
        logger,
      }),
    );

    indicator.markQueued();
    await settle();
    await indicator.clear();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the message was never marked", async () => {
    const addReaction = vi.fn(async () => {});
    const removeReaction = vi.fn(async () => {});
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { reactions: { addReaction, removeReaction } },
        resolveChannelId: () => "c1",
      }),
    );

    await indicator.clear();

    expect(addReaction).not.toHaveBeenCalled();
    expect(removeReaction).not.toHaveBeenCalled();
  });

  it("marks only once", async () => {
    const addReaction = vi.fn(async () => {});
    const removeReaction = vi.fn(async () => {});
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { reactions: { addReaction, removeReaction } },
        resolveChannelId: () => "c1",
      }),
    );

    indicator.markQueued();
    indicator.markQueued();
    await settle();

    expect(addReaction).toHaveBeenCalledTimes(1);
  });

  it("falls back to a reply when reactions are unsupported", async () => {
    const sendReply = vi.fn(async () => {});
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { replies: true },
        sendReply,
      }),
    );

    indicator.markQueued();
    await settle();

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(QUEUED_MESSAGE_NOTICE);

    // Reply fallbacks carry nothing to clear.
    await indicator.clear();
  });

  it("falls back to a post when the platform supports neither reactions nor replies", async () => {
    const sendPost = vi.fn(async () => {});
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: {},
        sendPost,
      }),
    );

    indicator.markQueued();
    await settle();

    expect(sendPost).toHaveBeenCalledTimes(1);
    expect(sendPost).toHaveBeenCalledWith(QUEUED_MESSAGE_NOTICE);
  });

  it("falls back to a reply when the channel cannot be resolved", async () => {
    const addReaction = vi.fn(async () => {});
    const removeReaction = vi.fn(async () => {});
    const sendReply = vi.fn(async () => {});
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { reactions: { addReaction, removeReaction }, replies: true },
        resolveChannelId: () => undefined,
        sendReply,
      }),
    );

    indicator.markQueued();
    await settle();

    expect(addReaction).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(QUEUED_MESSAGE_NOTICE);
  });

  it("logs when the fallback send fails", async () => {
    const logger = makeLogger();
    const sendReply = vi.fn(async () => {
      throw new Error("gone");
    });
    const indicator = createQueuedMessageIndicator(
      baseInput({
        capabilities: { replies: true },
        sendReply,
        logger,
      }),
    );

    indicator.markQueued();
    await settle();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
