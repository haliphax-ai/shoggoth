import { describe, it, vi } from "vitest";
import assert from "node:assert";
import { createDiscordHitlNotifier } from "../src/hitl/notifier";
import { NotFoundError } from "../src/rest-client";
import type { DiscordMessagingRuntime } from "../src/bridge";
import type { Logger, PendingActionRow } from "../src/daemon-types";
import type { DiscordRestTransport } from "../src/transport";
import type { HitlRiskTier } from "@shoggoth/shared";
import {
  daemonNotice,
  loadDaemonNotices,
  setPresentationNoticeResolver,
} from "@shoggoth/daemon/lib";

// The queued-notice formatter resolves copy through the daemon notice resolver.
loadDaemonNotices();
setPresentationNoticeResolver(daemonNotice);

function makeRow(id: string): PendingActionRow {
  return {
    id,
    sessionId: "agent:test:discord:channel:1",
    correlationId: undefined,
    toolName: "builtin-exec",
    resourceSummary: undefined,
    payload: {},
    riskTier: "caution" satisfies HitlRiskTier,
    status: "pending",
    denialReason: undefined,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function makeLogger() {
  const records: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    info(msg: string, fields?: Record<string, unknown>) {
      records.push({ msg, fields });
    },
    warn(msg: string, fields?: Record<string, unknown>) {
      records.push({ msg, fields });
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, records };
}

interface DmTransportOptions {
  /** Channel ids for which createMessage rejects with NotFoundError. */
  readonly deadChannels: ReadonlySet<string>;
  /** Reject every createMessage with this error (e.g. a non-404 failure). */
  readonly alwaysFailWith?: Error;
}

function makeTransport(opts: DmTransportOptions) {
  const createMessageChannels: string[] = [];
  let openDmCalls = 0;
  let createMessageCalls = 0;
  const transport = {
    async openDmChannel() {
      openDmCalls++;
      // Alternates so each re-resolve yields a new (also-trackable) id.
      return openDmCalls % 2 === 1 ? "dm-dead" : "dm-fresh";
    },
    async createMessage(channelId: string) {
      createMessageCalls++;
      createMessageChannels.push(channelId);
      if (opts.alwaysFailWith) throw opts.alwaysFailWith;
      if (opts.deadChannels.has(channelId)) {
        throw new NotFoundError("createMessage", 404, "{}");
      }
      return { id: `msg-${createMessageCalls}` };
    },
  } as unknown as DiscordRestTransport;
  return {
    transport,
    createMessageChannels,
    openDmCallCount: () => openDmCalls,
    createMessageCallCount: () => createMessageCalls,
  };
}

function makeRuntime(transport: DiscordRestTransport): DiscordMessagingRuntime {
  return { discordRestTransport: transport } as unknown as DiscordMessagingRuntime;
}

function makeNotifier(transport: DiscordRestTransport) {
  const { logger, records } = makeLogger();
  const notifier = createDiscordHitlNotifier({
    logger,
    env: { SHOGGOTH_HITL_NOTIFY_DM_USER_ID: "user-1" } as NodeJS.ProcessEnv,
    discord: makeRuntime(transport),
  });
  return { notifier, logger, records };
}

/**
 * Queue one notice and wait until its fire-and-forget DM chain has issued at
 * least `expected` createMessage attempts. When `settleLog` is given, also
 * wait for that log record: failure paths clear the cache before the final
 * warn fires, so seeing the record guarantees the chain fully settled before
 * the next notice is queued.
 */
async function queueAndAwait(
  notifier: { onQueued(row: PendingActionRow): void },
  t: { createMessageCallCount: () => number },
  row: PendingActionRow,
  expected: number,
  records?: ReadonlyArray<{ msg: string }>,
  settleLog?: string,
): Promise<void> {
  notifier.onQueued(row);
  await vi.waitFor(() => {
    assert.ok(t.createMessageCallCount() >= expected);
    if (settleLog) {
      assert.ok(
        records?.some((r) => r.msg === settleLog),
        `expected a "${settleLog}" record`,
      );
    }
  });
}

describe("hitl notifier DM channel cache", () => {
  it("recovers when the cached DM channel is deleted (404)", async () => {
    const t = makeTransport({ deadChannels: new Set(["dm-dead"]) });
    const { notifier } = makeNotifier(t.transport);

    await queueAndAwait(notifier, t, makeRow("row-1"), 2);

    // Re-resolved once and delivered on the fresh channel.
    assert.equal(t.openDmCallCount(), 2);
    assert.deepEqual(t.createMessageChannels, ["dm-dead", "dm-fresh"]);
  });

  it("keeps working on the next notice after a successful re-resolve", async () => {
    const t = makeTransport({ deadChannels: new Set(["dm-dead"]) });
    const { notifier } = makeNotifier(t.transport);

    await queueAndAwait(notifier, t, makeRow("row-1"), 2);
    await queueAndAwait(notifier, t, makeRow("row-2"), 3);

    // The fresh channel stays cached: no extra openDmChannel call.
    assert.equal(t.openDmCallCount(), 2);
    assert.deepEqual(t.createMessageChannels, ["dm-dead", "dm-fresh", "dm-fresh"]);
  });

  it("surfaces a second 404 without looping the re-resolve", async () => {
    const t = makeTransport({
      deadChannels: new Set(["dm-dead", "dm-fresh"]),
    });
    const { notifier, records } = makeNotifier(t.transport);

    await queueAndAwait(notifier, t, makeRow("row-1"), 2, records, "hitl.discord_dm_notify_failed");

    assert.equal(t.openDmCallCount(), 2);
    assert.deepEqual(t.createMessageChannels, ["dm-dead", "dm-fresh"]);
    assert.ok(
      records.some((r) => r.msg === "hitl.discord_dm_channel_gone"),
      "expected the invalidation log record",
    );
  });

  it("still surfaces non-404 errors untouched", async () => {
    const t = makeTransport({ deadChannels: new Set(), alwaysFailWith: new Error("discord down") });
    const { notifier, records } = makeNotifier(t.transport);

    await queueAndAwait(notifier, t, makeRow("row-1"), 1, records, "hitl.discord_dm_notify_failed");

    assert.equal(t.openDmCallCount(), 1);
    assert.deepEqual(t.createMessageChannels, ["dm-dead"]);
    assert.ok(!records.some((r) => r.msg === "hitl.discord_dm_channel_gone"));
  });

  it("re-resolves again after a double failure instead of pinning the dead id", async () => {
    const t = makeTransport({
      deadChannels: new Set(["dm-dead", "dm-fresh"]),
    });
    const { notifier, records } = makeNotifier(t.transport);

    await queueAndAwait(notifier, t, makeRow("row-1"), 2, records, "hitl.discord_dm_notify_failed");
    await queueAndAwait(notifier, t, makeRow("row-2"), 4, records, "hitl.discord_dm_notify_failed");

    // Both notices re-resolve: the dead id never stays cached.
    assert.equal(t.openDmCallCount(), 4);
    assert.deepEqual(t.createMessageChannels, ["dm-dead", "dm-fresh", "dm-dead", "dm-fresh"]);
  });
});
